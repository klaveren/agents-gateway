import { randomUUID } from 'node:crypto'
import { EventType, InMemorySessionService, LlmAgent, Runner, StreamingMode, toStructuredEvents, type BaseTool, type BaseToolset, type Event } from '@google/adk'
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
import { buildAdkMcpToolset, buildAdkTools } from '@infra/tools/bridges/Adk.ToolBridge'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { composeSystemPrompt } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gemini-3.7-flash'
const APP_NAME = 'agents-gateway'

interface IAdkPart {
  text?: string
  inlineData?: { data: string; mimeType: string }
}

export interface IAdkContent {
  role?: string
  parts?: IAdkPart[]
}

export interface IAdkRunParams {
  userId: string
  sessionId: string
  newMessage: IAdkContent
  abortSignal: AbortSignal
}

/**
 * A superfície mínima do ADK que este adapter usa. Existe para que o teste consiga
 * substituir o runtime inteiro sem subir `Runner`, `LlmAgent` nem tocar na rede.
 */
export interface IAdkRuntime {
  ensureSession(userId: string, sessionId: string): Promise<void>
  runAsync(params: IAdkRunParams): AsyncGenerator<Event, void, undefined>
}

export interface IAdkRuntimeSpec {
  name: string
  model: string
  instruction: string
  tools: Array<BaseTool | BaseToolset>
}

export type TAdkRuntimeFactory = (spec: IAdkRuntimeSpec) => IAdkRuntime

/** O runtime do ADK vive por sessão: é ele que carrega o histórico entre turnos. */
interface IGoogleAgentNative {
  runtime: IAdkRuntime
  userId: string
  adkSessionId: string
}

export interface IGoogleAgentAdapterDeps {
  createRuntime?: TAdkRuntimeFactory
  store?: SessionStore
  catalog?: ToolCatalog
}

function defaultRuntimeFactory(spec: IAdkRuntimeSpec): IAdkRuntime {
  const sessionService = new InMemorySessionService()
  const agent = new LlmAgent({
    name: spec.name,
    model: spec.model,
    // O ADK 1.6 usa `instruction` (singular) e `model`; não existem `instructions` nem `llm`.
    instruction: spec.instruction,
    tools: spec.tools,
  })
  const runner = new Runner({ appName: APP_NAME, agent, sessionService })

  return {
    async ensureSession(userId, sessionId) {
      // `runAsync` não cria sessão: sem isto ele lança "Session not found".
      await sessionService.getOrCreateSession({ appName: APP_NAME, userId, sessionId })
    },
    runAsync(params) {
      return runner.runAsync({
        userId: params.userId,
        sessionId: params.sessionId,
        newMessage: params.newMessage,
        // O default do ADK é StreamingMode.NONE — sem isto não há token a token.
        runConfig: { streamingMode: StreamingMode.SSE },
        abortSignal: params.abortSignal,
      })
    },
  }
}

/**
 * Lane `agent` do Gemini, sobre o `@google/adk`.
 *
 * O ADK usa `@google/genai` v2 por baixo, enquanto a lane chat usa o legado
 * `@google/generative-ai` v0.24 — dois clientes Gemini no mesmo processo, e é
 * exatamente o contraste que o estudo quer mostrar.
 */
export class GoogleAgentAdapter implements IAgentAdapter {
  private readonly createRuntime: TAdkRuntimeFactory
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog

  constructor(deps: IGoogleAgentAdapterDeps = {}) {
    this.createRuntime = deps.createRuntime ?? defaultRuntimeFactory
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.GOOGLE, EMode.AGENT), {
      agentId: agent.id,
      provider: EProvider.GOOGLE,
      mode: EMode.AGENT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
      language: input.language,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
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

    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    if (record.reasoning) {
      yield {
        type: 'warning',
        sessionId,
        timestamp: new Date(),
        payload: { message: '@google/adk 1.6 has no reasoning-effort knob; the setting was ignored.' },
      }
    }

    try {
      const native = this.nativeOf(record, agent)
      await native.runtime.ensureSession(native.userId, native.adkSessionId)

      const stream = native.runtime.runAsync({
        userId: native.userId,
        sessionId: native.adkSessionId,
        newMessage: this.buildContent(input),
        abortSignal: abort.signal,
      })

      // Em StreamingMode.SSE o ADK manda os pedaços com `partial: true` e depois um
      // evento agregado com o texto inteiro. Repassar os dois duplicaria a resposta.
      let sawPartialText = false

      for await (const event of stream) {
        const isPartial = event.partial === true

        for (const structured of toStructuredEvents(event)) {
          const carriesText = structured.type === EventType.CONTENT || structured.type === EventType.THOUGHT
          if (carriesText && !isPartial && sawPartialText) continue

          const mapped = this.toAgentEvent(structured, sessionId)
          if (mapped) yield mapped
        }

        if (isPartial) sawPartialText = true
        else sawPartialText = false
      }

      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[GoogleAgent] Error:', message)
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
   *
   * O runtime do ADK vive aqui porque é ele que carrega o histórico entre turnos: recriá-lo
   * a cada turno apagaria a conversa.
   */
  private nativeOf(record: ISessionRecord, agent: IAgent): IGoogleAgentNative {
    if (!record.native) {
      record.native = {
        runtime: this.createRuntime({
          name: this.toAdkName(agent.id),
          model: record.model,
          instruction: record.systemPrompt,
          tools: this.buildTools(agent),
        }),
        userId: `gateway-${record.id}`,
        adkSessionId: randomUUID(),
      } satisfies IGoogleAgentNative
    }
    return record.native as IGoogleAgentNative
  }

  private buildTools(agent: IAgent): Array<BaseTool | BaseToolset> {
    const tools: Array<BaseTool | BaseToolset> = buildAdkTools(this.catalog?.localFor(agent.allowedTools) ?? [])
    const remote = this.catalog?.mcpConnected ? buildAdkMcpToolset(this.catalog.mcpUrl) : undefined
    if (remote) tools.push(remote)
    return tools
  }

  private toAgentEvent(event: ReturnType<typeof toStructuredEvents>[number], sessionId: string): IAgentEvent | undefined {
    const timestamp = new Date()

    switch (event.type) {
      case EventType.CONTENT:
        return { type: 'text.delta', sessionId, timestamp, payload: { text: event.content } }
      case EventType.THOUGHT:
        return { type: 'reasoning.delta', sessionId, timestamp, payload: { text: event.content } }
      case EventType.TOOL_CALL:
        return {
          type: 'tool.started',
          sessionId,
          timestamp,
          payload: { tool: event.call.name ?? 'unknown', args: event.call.args ?? {} },
        }
      case EventType.TOOL_RESULT:
        return {
          type: 'tool.result',
          sessionId,
          timestamp,
          payload: { tool: event.result.name ?? 'unknown', result: event.result.response },
        }
      case EventType.ERROR:
        return { type: 'error', sessionId, timestamp, payload: { message: event.error.message } }
      default:
        return undefined
    }
  }

  private buildContent(input: IMessageInput): IAdkContent {
    const parts: IAdkPart[] = [{ text: input.text }]
    for (const file of input.files ?? []) {
      parts.push({ inlineData: { data: file.data, mimeType: file.mimeType } })
    }
    return { role: 'user', parts }
  }

  /** O ADK exige um nome de agente em forma de identificador. */
  private toAdkName(agentId: string): string {
    return agentId.replace(/[^A-Za-z0-9_]/g, '_')
  }
}
