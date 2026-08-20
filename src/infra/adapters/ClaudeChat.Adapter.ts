import Anthropic from '@anthropic-ai/sdk'
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
import { composeSystemPrompt, maxOutputTokens } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'claude-sonnet-5'

/** `output_config.effort` da Messages API. Anything else is dropped. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type TEffort = (typeof EFFORTS)[number]

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type TImageType = (typeof IMAGE_TYPES)[number]

type THistory = Anthropic.MessageParam[]

export interface IClaudeChatAdapterDeps {
  client?: Anthropic
  store?: SessionStore
}

/**
 * Lane `chat` do Claude: conversa pura sobre o SDK normal.
 *
 * Sem tools por desenho — quem executa tool é a lane `agent`, e lá quem conduz o
 * loop é o Agents SDK, não nós.
 */
export class ClaudeChatAdapter implements IAgentAdapter {
  private readonly client: Anthropic
  private readonly store: SessionStore

  constructor(deps: IClaudeChatAdapterDeps = {}) {
    this.client = deps.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy' })
    this.store = deps.store ?? new SessionStore()
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.CLAUDE, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.CLAUDE,
      mode: EMode.CHAT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
      language: input.language,
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

    const history = this.historyOf(record)
    const { content, warnings } = this.buildUserContent(input)
    history.push({ role: 'user', content })

    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }
    for (const message of warnings) {
      yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message } }
    }

    let text = ''

    try {
      const params: Anthropic.MessageCreateParamsStreaming = {
        model: record.model,
        system: record.systemPrompt,
        max_tokens: maxOutputTokens(),
        messages: [...history],
        stream: true,
      }

      const effort = this.toEffort(record.reasoning)
      if (effort) params.output_config = { effort }

      const stream = await this.client.messages.create(params, { signal: abort.signal })

      for await (const chunk of stream) {
        if (chunk.type === 'message_start') {
          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: { inputTokens: chunk.message.usage.input_tokens },
          }
        } else if (chunk.type === 'content_block_delta') {
          if (chunk.delta.type === 'text_delta') {
            text += chunk.delta.text
            yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: chunk.delta.text } }
          } else if (chunk.delta.type === 'thinking_delta') {
            yield { type: 'reasoning.delta', sessionId, timestamp: new Date(), payload: { text: chunk.delta.thinking } }
          }
        } else if (chunk.type === 'message_delta') {
          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: {
              outputTokens: chunk.usage.output_tokens,
              reasoningTokens: chunk.usage.output_tokens_details?.thinking_tokens ?? undefined,
            },
          }
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
      console.error('[ClaudeChat] Error:', message)
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message } }
    } finally {
      record.abort = undefined
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * Fecha o turno no history. Se a geração morreu antes de produzir texto, o turno
   * do usuário é removido — a Messages API recusa dois `user` seguidos, e é isso
   * que um cancelamento no meio do stream deixaria para trás.
   */
  /**
   * O store é compartilhado pelos seis adapters, então o slot nativo é `unknown`. Este é o
   * único ponto do adapter que sabe o formato do que ele guardou lá.
   */
  private historyOf(record: ISessionRecord): THistory {
    if (!record.native) record.native = [] satisfies THistory
    return record.native as THistory
  }

  private settle(record: ISessionRecord, history: THistory, text: string): void {
    if (text) {
      history.push({ role: 'assistant', content: [{ type: 'text', text }] })
    } else if (history[history.length - 1]?.role === 'user') {
      history.pop()
    }
  }

  private buildUserContent(input: IMessageInput): { content: Anthropic.ContentBlockParam[]; warnings: string[] } {
    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: input.text }]
    const warnings: string[] = []

    for (const file of input.files ?? []) {
      if (this.isImageType(file.mimeType)) {
        content.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } })
      } else if (file.mimeType === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } })
      } else {
        warnings.push(`Attachment "${file.name}" (${file.mimeType}) is not supported by Claude and was skipped.`)
      }
    }

    return { content, warnings }
  }

  private isImageType(mimeType: string): mimeType is TImageType {
    return (IMAGE_TYPES as readonly string[]).includes(mimeType)
  }

  private toEffort(reasoning: string | undefined): TEffort | undefined {
    return (EFFORTS as readonly string[]).includes(reasoning ?? '') ? (reasoning as TEffort) : undefined
  }
}
