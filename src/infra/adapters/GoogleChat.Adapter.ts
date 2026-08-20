import { Content, FunctionDeclaration, GoogleGenerativeAI, Part, Tool } from '@google/generative-ai'
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
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { IToolDefinition } from '@infra/tools/Tool.Types'
import { IManualLoopProvider, IManualToolCall, IManualTurnOutcome, runManualToolLoop } from './support/ManualTool.Loop'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gemini-3.7-flash'

type THistory = Content[]

export interface IGoogleChatAdapterDeps {
  client?: GoogleGenerativeAI
  store?: SessionStore
  catalog?: ToolCatalog
}

/**
 * Lane `chat` do Gemini: conversa pura sobre o SDK normal, sem tools.
 *
 * Duas correções em relação ao adapter anterior: o system prompt vai só em
 * `systemInstruction` (antes ia também como primeira mensagem `user`, duplicado), e o
 * `AbortSignal` vai no segundo argumento de `generateContentStream` — o
 * `RequestOptions` de `getGenerativeModel` não tem campo `signal` nesta versão.
 */
export class GoogleChatAdapter implements IAgentAdapter {
  private readonly client: GoogleGenerativeAI
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog

  constructor(deps: IGoogleChatAdapterDeps = {}) {
    this.client = deps.client ?? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'AIzaSy-dummy')
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.GOOGLE, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.GOOGLE,
      mode: EMode.CHAT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
      language: input.language,
      tools: input.tools === true,
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
    const checkpoint = history.length

    history.push({ role: 'user', parts: this.buildParts(input) })

    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }

    if (record.reasoning) {
      yield {
        type: 'warning',
        sessionId,
        timestamp: new Date(),
        payload: { message: '@google/generative-ai 0.24 has no thinking control; the reasoning setting was ignored.' },
      }
    }

    try {
      const tools = record.tools ? ((await this.catalog?.list(agent.allowedTools)) ?? []) : []

      yield* runManualToolLoop<Content>({
        sessionId,
        history,
        tools,
        catalog: this.catalog,
        provider: this.loopProvider(record, sessionId),
        signal: abort.signal,
        maxTurns: maxToolTurns(),
      })

      if (abort.signal.aborted) {
        history.length = checkpoint
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      history.length = checkpoint

      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[GoogleChat] Error:', message)
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
  private historyOf(record: ISessionRecord): THistory {
    if (!record.native) record.native = [] satisfies THistory
    return record.native as THistory
  }

  /**
   * A parte do loop que só o Gemini sabe fazer: declarar `functionDeclarations`, achar o
   * `functionCall` nas parts do stream, e devolver o `functionResponse` no history.
   */
  private loopProvider(record: ISessionRecord, sessionId: string): IManualLoopProvider<Content> {
    const client = this.client

    return {
      async *runTurn(history, tools, signal): AsyncGenerator<IAgentEvent, IManualTurnOutcome> {
        const declarations: FunctionDeclaration[] = tools.map(toFunctionDeclaration)
        const declared: Tool[] = declarations.length > 0 ? [{ functionDeclarations: declarations }] : []

        const model = client.getGenerativeModel({
          model: record.model,
          systemInstruction: record.systemPrompt,
          generationConfig: { maxOutputTokens: maxOutputTokens() },
          ...(declared.length > 0 ? { tools: declared } : {}),
        })

        const result = await model.generateContentStream({ contents: [...history] }, { signal })

        let text = ''
        const calls: IManualToolCall[] = []

        for await (const chunk of result.stream) {
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (part.text) {
              text += part.text
              yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: part.text } }
            } else if (part.functionCall) {
              calls.push({
                // O Gemini não dá id à chamada; o casamento é por nome e ordem.
                id: `${part.functionCall.name}-${calls.length}`,
                name: part.functionCall.name,
                args: (part.functionCall.args ?? {}) as Record<string, unknown>,
              })
            }
          }
        }

        const aggregate = await result.response
        if (aggregate.usageMetadata) {
          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: {
              inputTokens: aggregate.usageMetadata.promptTokenCount,
              outputTokens: aggregate.usageMetadata.candidatesTokenCount,
            },
          }
        }

        return { text, calls }
      },

      appendAssistant(history, outcome) {
        const parts: Part[] = []
        if (outcome.text) parts.push({ text: outcome.text })
        for (const call of outcome.calls) {
          parts.push({ functionCall: { name: call.name, args: call.args } })
        }

        if (parts.length > 0) history.push({ role: 'model', parts })
      },

      appendToolResults(history, results) {
        history.push({
          role: 'user',
          parts: results.map((entry) => ({
            functionResponse: { name: entry.call.name, response: { result: entry.outcome.result } },
          })),
        })
      },
    }
  }

  private buildParts(input: IMessageInput): Part[] {
    const parts: Part[] = [{ text: input.text }]
    for (const file of input.files ?? []) {
      parts.push({ inlineData: { data: file.data, mimeType: file.mimeType } })
    }
    return parts
  }
}

function toFunctionDeclaration(tool: IToolDefinition): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as FunctionDeclaration['parameters'],
  }
}
