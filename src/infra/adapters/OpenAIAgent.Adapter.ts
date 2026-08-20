import { Agent, run, user, type AgentInputItem, type MCPServer, type ModelSettings } from '@openai/agents'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { buildOpenAIMcpServers, buildOpenAITools } from '@infra/tools/bridges/OpenAI.ToolBridge'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gpt-5.6-sol'
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

type TEffort = NonNullable<NonNullable<ModelSettings['reasoning']>['effort']>
type TRun = typeof run
type TUserContent = Parameters<typeof user>[0]

export type TBuildMcpServers = (url: string) => MCPServer[]

export interface IOpenAIAgentAdapterDeps {
  run?: TRun
  store?: SessionStore
  catalog?: ToolCatalog
  /** Injetável para o teste não precisar de um MCP server no ar. */
  buildMcpServers?: TBuildMcpServers
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
  /**
   * Uma conexão MCP por adapter, compartilhada pelas sessões e aberta sob demanda. A
   * geração vem do cliente MCP: quando ele reconecta, estes servers ficaram velhos.
   */
  private mcp?: { generation: number; servers: Promise<MCPServer[]> }

  constructor(deps: IOpenAIAgentAdapterDeps = {}) {
    this.run = deps.run ?? run
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

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }

    const history = this.historyOf(record)
    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    const modelSettings: ModelSettings = { maxTokens: maxOutputTokens() }
    const effort = this.toEffort(record.reasoning)
    if (effort) modelSettings.reasoning = { effort }

    const oaiAgent = new Agent({
      name: agent.name,
      instructions: record.systemPrompt,
      model: record.model,
      modelSettings,
      tools: buildOpenAITools(this.catalog?.localFor(agent.allowedTools) ?? []),
      mcpServers: await this.connectMcpServers(),
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
   * Perguntar ao catálogo a cada turno é o que faz um MCP server que subiu depois do
   * gateway entrar em uso sem reiniciar o processo.
   */
  private async connectMcpServers(): Promise<MCPServer[]> {
    const url = await this.catalog?.mcpEndpoint()

    if (!url || !this.catalog) {
      await this.closeMcpServers()
      return []
    }

    const generation = this.catalog.mcpGeneration
    if (this.mcp?.generation !== generation) {
      await this.closeMcpServers()
      this.mcp = {
        generation,
        servers: (async () => {
          const servers = this.buildMcpServers(url)
          await Promise.all(servers.map((server) => server.connect()))
          return servers
        })().catch((error: unknown) => {
          console.warn('[OpenAIAgent] MCP indisponível, seguindo só com as tools locais:', error)
          this.mcp = undefined
          return []
        }),
      }
    }

    return this.mcp.servers
  }

  private async closeMcpServers(): Promise<void> {
    const stale = this.mcp
    this.mcp = undefined
    if (!stale) return

    const servers = await stale.servers.catch(() => [])
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
  }

  private buildUserContent(input: IMessageInput): TUserContent {
    const files = input.files ?? []
    if (files.length === 0) return input.text

    const content: Exclude<TUserContent, string> = [{ type: 'input_text', text: input.text }]

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

  private readUsage(data: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
    if (typeof data !== 'object' || data === null) return undefined

    const response = (data as { response?: unknown }).response
    if (typeof response !== 'object' || response === null) return undefined

    const usage = (response as { usage?: unknown }).usage
    if (typeof usage !== 'object' || usage === null) return undefined

    const { inputTokens, outputTokens } = usage as { inputTokens?: unknown; outputTokens?: unknown }
    return {
      inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
    }
  }

  private toEffort(reasoning: string | undefined): TEffort | undefined {
    return (EFFORTS as readonly string[]).includes(reasoning ?? '') ? (reasoning as TEffort) : undefined
  }
}
