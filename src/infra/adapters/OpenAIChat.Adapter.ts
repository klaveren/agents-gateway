import OpenAI from 'openai'
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

const DEFAULT_MODEL = 'gpt-5.6-sol'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type TEffort = (typeof EFFORTS)[number]

/** Só o diálogo. O system prompt fica na sessão e é prefixado a cada requisição. */
type THistory = OpenAI.Chat.ChatCompletionMessageParam[]

export interface IOpenAIChatAdapterDeps {
  client?: OpenAI
  store?: SessionStore<THistory>
}

/**
 * Lane `chat` do GPT: conversa pura sobre o SDK normal, sem tools.
 */
export class OpenAIChatAdapter implements IAgentAdapter {
  private readonly client: OpenAI
  private readonly store: SessionStore<THistory>

  constructor(deps: IOpenAIChatAdapterDeps = {}) {
    this.client = deps.client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sk-dummy' })
    this.store = deps.store ?? new SessionStore<THistory>()
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.OPENAI, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.OPENAI,
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
      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: record.model,
        messages: [{ role: 'system', content: record.systemPrompt }, ...history],
        max_completion_tokens: maxOutputTokens(),
        stream: true,
        stream_options: { include_usage: true },
      }

      const effort = this.toEffort(record.reasoning)
      if (effort) params.reasoning_effort = effort

      const stream = await this.client.chat.completions.create(params, { signal: abort.signal })

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (delta?.content) {
          text += delta.content
          yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: delta.content } }
        }

        if (chunk.usage) {
          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: {
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
              reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
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
      console.error('[OpenAIChat] Error:', message)
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
      history.push({ role: 'assistant', content: text })
    } else if (history[history.length - 1]?.role === 'user') {
      history.pop()
    }
    record.native = history
  }

  private buildUserContent(input: IMessageInput): {
    content: OpenAI.Chat.ChatCompletionContentPart[]
    warnings: string[]
  } {
    const content: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: input.text }]
    const warnings: string[] = []

    for (const file of input.files ?? []) {
      if (file.mimeType.startsWith('image/')) {
        content.push({ type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data}` } })
      } else if (file.mimeType === 'application/pdf') {
        // A v7 ganhou a content part `file`; o adapter anterior descartava PDF em silêncio.
        content.push({
          type: 'file',
          file: { filename: file.name, file_data: `data:${file.mimeType};base64,${file.data}` },
        })
      } else {
        warnings.push(`Attachment "${file.name}" (${file.mimeType}) is not supported by GPT and was skipped.`)
      }
    }

    return { content, warnings }
  }

  private toEffort(reasoning: string | undefined): TEffort | undefined {
    return (EFFORTS as readonly string[]).includes(reasoning ?? '') ? (reasoning as TEffort) : undefined
  }
}
