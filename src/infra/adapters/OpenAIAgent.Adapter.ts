import { Agent, OpenAIProvider, run, user, type AgentInputItem, type MCPServer, type Model, type ModelSettings } from '@openai/agents'
import { ICredentialSource } from '@domain/ports/CredentialStore.Port'
import { requireKey } from './support/Keyed.Client'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent, IUsage } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { buildOpenAIMcpServers, buildOpenAITools } from '@infra/tools/bridges/OpenAI.ToolBridge'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { cacheTokensOf } from './support/Usage.Helper'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gpt-5.6-sol'
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type TEffort = NonNullable<NonNullable<ModelSettings['reasoning']>['effort']>
type TRun = typeof run
type TUserContent = Parameters<typeof user>[0]

export type TBuildMcpServers = (url: string, token?: string) => MCPServer[]

export interface IOpenAIAgentAdapterDeps {
  run?: TRun
  store?: SessionStore
  catalog?: ToolCatalog
  /** Injetável para o teste não precisar de um MCP server no ar. */
  buildMcpServers?: TBuildMcpServers
  /** De onde vem a chave em cada turno. Ausente = o provider padrão do SDK, que lê o ambiente. */
  credentials?: ICredentialSource
}

/**
 * Lane `agent` do GPT, sobre o `@openai/agents`.
 *
 * O loop de tools é do `run()`; aqui só traduzimos o stream de eventos do SDK para o
 * `IAgentEvent` do gateway e guardamos o history entre turnos.
 */
export class OpenAIAgentAdapter implements IAgentAdapter {
  private readonly run: TRun
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog
  private readonly buildMcpServers: TBuildMcpServers
  private readonly credentials?: ICredentialSource
  /**
   * O provider do SDK por chave. ⚠️ Não é o provider PADRÃO do `@openai/agents`: aquele guarda o
   * cliente criado na primeira chamada, e trocar a chave depois não mudaria nada.
   */
  private provider?: { key: string; provider: OpenAIProvider }

  constructor(deps: IOpenAIAgentAdapterDeps = {}) {
    this.run = deps.run ?? run
    this.credentials = deps.credentials
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
    this.buildMcpServers = deps.buildMcpServers ?? buildOpenAIMcpServers
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.OPENAI, EMode.AGENT), {
      agentId: agent.id,
      provider: EProvider.OPENAI,
      mode: EMode.AGENT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      native: [],
    })

    return {
      id: record.id,
      provider: record.provider,
      mode: record.mode,
      createdAt: record.createdAt,
      metadata: record.metadata,
    }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent> {
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }

    const history = this.historyOf(record)
    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    let model: string | Model
    try {
      model = await this.modelFor(record.model)
    } catch (error: unknown) {
      record.abort = undefined
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: error instanceof Error ? error.message : String(error) } }
      return
    }

    const modelSettings: ModelSettings = { maxTokens: maxOutputTokens() }
    const effort = this.toEffort(record.reasoning)
    if (effort) modelSettings.reasoning = { effort }

    // Conexão MCP POR TURNO. O adapter é singleton; um slot compartilhado fazia o turno de um
    // usuário fechar as tools de outro no meio do stream, e vazava a conexão de quem perdia a corrida.
    const mcpServers = await this.openMcpServers(context)

    const oaiAgent = new Agent({
      name: agent.name,
      instructions: record.systemPrompt,
      model,
      modelSettings,
      tools: buildOpenAITools(this.catalog?.localFor(agent.allowedTools) ?? []),
      mcpServers,
    })

    const items: AgentInputItem[] = [...history, user(this.buildUserContent(input))]

    try {
      const stream = await this.run(oaiAgent, items, {
        stream: true,
        signal: abort.signal,
        maxTurns: maxToolTurns(),
      })

      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event') {
          if (event.data.type === 'output_text_delta') {
            yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: event.data.delta } }
          } else if (event.data.type === 'response_done') {
            const usage = this.readUsage(event.data)
            if (usage) yield { type: 'usage', sessionId, timestamp: new Date(), payload: usage }
          }
          continue
        }

        if (event.type !== 'run_item_stream_event') continue

        if (event.name === 'tool_called' && event.item.type === 'tool_call_item') {
          const call = this.readToolCall(event.item.rawItem)
          yield { type: 'tool.started', sessionId, timestamp: new Date(), payload: call }
        } else if (event.name === 'tool_output' && event.item.type === 'tool_call_output_item') {
          const call = this.readToolCall(event.item.rawItem)
          yield {
            type: 'tool.result',
            sessionId,
            timestamp: new Date(),
            payload: { tool: call.tool, result: event.item.output },
          }
        }
      }

      await stream.completed
      record.native = stream.history

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[OpenAIAgent] Error:', message)
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message } }
    } finally {
      record.abort = undefined
      await this.closeMcpServers(mcpServers)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * O store é compartilhado pelos seis adapters, então o slot nativo é `unknown`. Este é o
   * único ponto do adapter que sabe o formato do que ele guardou lá.
   */
  private historyOf(record: ISessionRecord): AgentInputItem[] {
    if (!record.native) record.native = [] as AgentInputItem[]
    return record.native as AgentInputItem[]
  }

  /**
   * O SDK não conecta os MCP servers sozinho: o ciclo de vida é de quem os passa.
   *
   * Os headers do MCP (a credencial de quem chama) ficam fixados na conexão, então ela pertence ao
   * turno: aberta aqui, fechada no `finally` do mesmo turno. Nada é compartilhado entre usuários, e
   * perguntar ao catálogo a cada turno é o que pega um MCP que subiu depois do gateway.
   */
  /** O modelo pela chave em vigor AGORA; sem store, o nome — e o SDK resolve com o padrão dele. */
  private async modelFor(name: string): Promise<string | Model> {
    if (!this.credentials) return name

    const key = requireKey(EProvider.OPENAI, this.credentials)
    if (this.provider?.key !== key) this.provider = { key, provider: new OpenAIProvider({ apiKey: key }) }
    return this.provider.provider.getModel(name)
  }

  private async openMcpServers(context: IExecutionContext): Promise<MCPServer[]> {
    const url = await this.catalog?.mcpEndpoint()
    if (!url) return []

    const servers = this.buildMcpServers(url, context.token)
    try {
      await Promise.all(servers.map((server) => server.connect()))
      return servers
    } catch (error: unknown) {
      console.warn('[OpenAIAgent] MCP indisponível, seguindo só com as tools locais:', error)
      await this.closeMcpServers(servers)
      return []
    }
  }

  private async closeMcpServers(servers: MCPServer[]): Promise<void> {
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
  }

  private buildUserContent(input: IMessageInput): TUserContent {
    const files = input.files ?? []
    if (files.length === 0) return input.text

    // Texto vazio não vira parte — anexo sem frase é mensagem válida.
    const content: Exclude<TUserContent, string> = input.text.trim() ? [{ type: 'input_text', text: input.text }] : []

    for (const file of files) {
      const dataUrl = `data:${file.mimeType};base64,${file.data}`
      if (file.mimeType.startsWith('image/')) {
        content.push({ type: 'input_image', image: dataUrl })
      } else {
        content.push({ type: 'input_file', file: dataUrl, filename: file.name })
      }
    }

    return content
  }

  /** O `rawItem` do SDK é uma união larga; lemos por forma em vez de castar para `any`. */
  private readToolCall(rawItem: unknown): { tool: string; args: Record<string, unknown> } {
    if (typeof rawItem !== 'object' || rawItem === null) return { tool: 'unknown', args: {} }

    const raw = rawItem as { name?: unknown; arguments?: unknown }
    const tool = typeof raw.name === 'string' ? raw.name : 'unknown'

    if (typeof raw.arguments !== 'string') return { tool, args: {} }

    try {
      const parsed: unknown = JSON.parse(raw.arguments)
      return { tool, args: typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {} }
    } catch {
      return { tool, args: {} }
    }
  }

  private readUsage(data: unknown): IUsage | undefined {
    if (typeof data !== 'object' || data === null) return undefined

    const response = (data as { response?: unknown }).response
    if (typeof response !== 'object' || response === null) return undefined

    const usage = (response as { usage?: unknown }).usage
    if (typeof usage !== 'object' || usage === null) return undefined

    const { inputTokens, outputTokens, outputTokensDetails, inputTokensDetails } = usage as {
      inputTokens?: unknown
      outputTokens?: unknown
      outputTokensDetails?: unknown
      inputTokensDetails?: unknown
    }

    /**
     * ⚠️ O RACIOCÍNIO VEM NUM SUB-OBJETO, e já está DENTRO de `outputTokens`.
     *
     * O contrato do gateway é um só: `outputTokens` é a saída VISÍVEL, e o raciocínio vem à parte
     * (como o Gemini já devolve). Aqui ele é SUBTRAÍDO da saída e informado separado — deixá-lo nos
     * dois contaria o raciocínio duas vezes no total e no custo.
     */
    const details = (typeof outputTokensDetails === 'object' && outputTokensDetails !== null ? outputTokensDetails : {}) as { reasoningTokens?: unknown }
    const reasoning = typeof details.reasoningTokens === 'number' ? details.reasoningTokens : 0

    const output = typeof outputTokens === 'number' ? outputTokens : undefined

    return {
      inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
      outputTokens: output === undefined ? undefined : Math.max(output - reasoning, 0),
      reasoningTokens: reasoning || undefined,
      cacheReadTokens: cacheTokensOf(inputTokensDetails, 'cached_tokens'),
      cacheWriteTokens: cacheTokensOf(inputTokensDetails, 'cache_write_tokens'),
    }
  }

  private toEffort(reasoning: string | undefined): TEffort | undefined {
    return (EFFORTS as readonly string[]).includes(reasoning ?? '') ? (reasoning as TEffort) : undefined
  }
}
