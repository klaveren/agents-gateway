import { Content, GoogleGenerativeAI, Part } from '@google/generative-ai'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { SessionStore } from '@infra/session/Session.Store'
import { composeSystemPrompt, maxOutputTokens } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gemini-3.7-flash'

type THistory = Content[]

export interface IGoogleChatAdapterDeps {
  client?: GoogleGenerativeAI
  store?: SessionStore<THistory>
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
  private readonly store: SessionStore<THistory>

  constructor(deps: IGoogleChatAdapterDeps = {}) {
    this.client = deps.client ?? new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || 'AIzaSy-dummy')
    this.store = deps.store ?? new SessionStore<THistory>()
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.GOOGLE, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.GOOGLE,
      mode: EMode.CHAT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
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

  async *sendMessage(_agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }

    const history: THistory = record.native ?? []
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

    let text = ''

    try {
      const model = this.client.getGenerativeModel({
        model: record.model,
        systemInstruction: record.systemPrompt,
        generationConfig: { maxOutputTokens: maxOutputTokens() },
      })

      const result = await model.generateContentStream({ contents: [...history] }, { signal: abort.signal })

      for await (const chunk of result.stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            text += part.text
            yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: part.text } }
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

      this.settle(record, history, text)
      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      this.settle(record, history, text)

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

  private settle(record: { native?: THistory }, history: THistory, text: string): void {
    if (text) {
      history.push({ role: 'model', parts: [{ text }] })
    } else if (history[history.length - 1]?.role === 'user') {
      history.pop()
    }
    record.native = history
  }

  private buildParts(input: IMessageInput): Part[] {
    const parts: Part[] = [{ text: input.text }]
    for (const file of input.files ?? []) {
      parts.push({ inlineData: { data: file.data, mimeType: file.mimeType } })
    }
    return parts
  }
}
