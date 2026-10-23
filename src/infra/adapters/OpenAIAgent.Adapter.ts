import {
  Agent,
  codeInterpreterTool,
  imageGenerationTool,
  OpenAIProvider,
  run,
  user,
  webSearchTool,
  type AgentInputItem,
  type MCPServer,
  type Model,
  type ModelSettings,
  type Tool,
} from '@openai/agents'
import { NATIVE_TOOLS, nativeToolsOf } from '@domain/Native.Tools'
import { IConnectionSource, requireConnection } from './support/Keyed.Client'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { reasoningLevel } from '@domain/Reasoning.Levels'
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
import { IAgentMcpServer, ToolCatalog } from '@infra/tools/Tool.Catalog'
import { cacheTokensOf } from './support/Usage.Helper'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

type TEffort = NonNullable<NonNullable<ModelSettings['reasoning']>['effort']>
type TRun = typeof run
type TUserContent = Parameters<typeof user>[0]

export type TBuildMcpServers = (remotes: readonly IAgentMcpServer[], token?: string) => MCPServer[]

export interface IOpenAIAgentAdapterDeps {
  run?: TRun
  store?: SessionStore
  catalog?: ToolCatalog
  /** Injetável para o teste não precisar de um MCP server no ar. */
  buildMcpServers?: TBuildMcpServers
  /** De onde vêm a chave e a URL em cada turno. Ausente = o provider padrão do SDK, que lê o ambiente. */
  connections?: IConnectionSource
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
  private readonly connections?: IConnectionSource
  /**
   * O provider do SDK por chave. ⚠️ Não é o provider PADRÃO do `@openai/agents`: aquele guarda o
   * cliente criado na primeira chamada, e trocar a chave depois não mudaria nada.
   */
  private readonly providers = new Map<string, { signature: string; provider: OpenAIProvider }>()

  constructor(deps: IOpenAIAgentAdapterDeps = {}) {
    this.run = deps.run ?? run
    this.connections = deps.connections
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
    this.buildMcpServers = deps.buildMcpServers ?? buildOpenAIMcpServers
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.OPENAI, EMode.AGENT), {
      agentId: agent.id,
      provider: agent.provider,
      protocol: EProvider.OPENAI,
      mode: EMode.AGENT,
      // O modelo vem resolvido pelo provider de sessões (o pedido, ou o padrão do agente).
      model: input.model || agent.models[0] || '',
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
      model = await this.modelFor(record.provider, record.model)
    } catch (error: unknown) {
      record.abort = undefined
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: error instanceof Error ? error.message : String(error) } }
      return
    }

    // Nativas (hospedadas) exigem a Responses API: só com o provider oficial. Num compatível, ficam de fora — e o turno diz isso.
    const natives = nativeToolsOf(agent.allowedTools, EProvider.OPENAI)
    const compatible = natives.length > 0 && !!this.connections?.connection(record.provider)?.baseUrl
    if (compatible)
      yield {
        type: 'warning',
        sessionId,
        timestamp: new Date(),
        payload: { message: `Ferramentas hospedadas da OpenAI não funcionam em provider compatível e foram ignoradas: ${natives.map((tool) => tool.label).join(', ')}.` },
      }
    const hosted = compatible ? [] : natives.map((tool) => hostedTool(tool.sdkName)).filter((tool): tool is Tool => !!tool)

    const modelSettings: ModelSettings = { maxTokens: maxOutputTokens() }
    const effort = this.toEffort(record.reasoning)
    if (effort) modelSettings.reasoning = { effort }

    // Conexão MCP POR TURNO. O adapter é singleton; um slot compartilhado fazia o turno de um
    // usuário fechar as tools de outro no meio do stream, e vazava a conexão de quem perdia a corrida.
    const mcpServers = await this.openMcpServers(context, agent.allowedTools)

    const oaiAgent = new Agent({
      name: agent.name,
      instructions: record.systemPrompt,
      model,
      modelSettings,
      tools: [...buildOpenAITools(this.catalog?.localFor(agent.allowedTools) ?? [], context), ...hosted],
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
  /**
   * O modelo pela conexão em vigor AGORA; sem fonte, o nome — e o SDK resolve com o padrão dele.
   *
   * ⚠️ COMPATÍVEL VAI POR CHAT COMPLETIONS (`useResponses: false`): a Responses API é da OpenAI, e
   * OpenRouter, vLLM e LiteLLM em geral só falam Chat Completions.
   */
  private async modelFor(providerId: string, name: string): Promise<string | Model> {
    if (!this.connections) return name

    const connection = requireConnection(providerId, EProvider.OPENAI, this.connections)
    const signature = `${connection.baseUrl ?? ''}\u0000${connection.key}`
    let entry = this.providers.get(providerId)
    if (!entry || entry.signature !== signature) {
      entry = { signature, provider: new OpenAIProvider({ apiKey: connection.key, baseURL: connection.baseUrl, useResponses: !connection.compatible }) }
      this.providers.set(providerId, entry)
    }
    return entry.provider.getModel(name)
  }

  /** Os servidores MCP que ESTE agente escolheu. ⚖️ Um que não conecta sai sozinho: os outros seguem. */
  private async openMcpServers(context: IExecutionContext, allowedTools: readonly string[]): Promise<MCPServer[]> {
    const remotes = (await this.catalog?.mcpServersFor(allowedTools)) ?? []
    if (!remotes.length) return []

    const servers = this.buildMcpServers(remotes, context.token)
    const opened = await Promise.all(
      servers.map(async (server) => {
        try {
          await server.connect()
          return server
        } catch (error: unknown) {
          console.warn(`[OpenAIAgent] MCP ${server.name} indisponível, seguindo sem ele:`, error)
          await server.close().catch(() => undefined)
          return undefined
        }
      }),
    )
    return opened.filter((server): server is MCPServer => !!server)
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
    const tool = hostedName(typeof raw.name === 'string' ? raw.name : 'unknown')

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
    return reasoningLevel(EProvider.OPENAI, reasoning) as TEffort | undefined
  }
}

/** A ferramenta hospedada do SDK pelo nome do catálogo (`Native.Tools`). */
function hostedTool(name: string): Tool | undefined {
  if (name === 'web_search') return webSearchTool()
  if (name === 'code_interpreter') return codeInterpreterTool()
  if (name === 'image_generation') return imageGenerationTool()
  return undefined
}

/**
 * A chamada de uma ferramenta hospedada chega com o tipo do item da Responses API (`web_search_call`,
 * `code_interpreter_call`); o histórico grava o nome do catálogo (`web_search`), o mesmo que o agente
 * liga — e é por ele que a tela mostra "Busca na web".
 */
export function hostedName(name: string): string {
  const base = name.replace(/_call$/, '')
  return NATIVE_TOOLS.some((tool) => tool.protocol === EProvider.OPENAI && tool.sdkName === base) ? base : name
}
