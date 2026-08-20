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
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { IToolDefinition } from '@infra/tools/Tool.Types'
import { IManualLoopProvider, IManualToolCall, IManualTurnOutcome, runManualToolLoop } from './support/ManualTool.Loop'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'gpt-5.6-sol'

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type TEffort = (typeof EFFORTS)[number]

/** Só o diálogo. O system prompt fica na sessão e é prefixado a cada requisição. */
type THistory = OpenAI.Chat.ChatCompletionMessageParam[]

export interface IOpenAIChatAdapterDeps {
  client?: OpenAI
  store?: SessionStore
  catalog?: ToolCatalog
}

/**
 * Lane `chat` do GPT, sobre o SDK normal.
 *
 * Por padrão é conversa pura. Com `tools: true` na sessão, o turno passa pelo loop escrito
 * à mão em `support/ManualTool.Loop`.
 */
export class OpenAIChatAdapter implements IAgentAdapter {
  private readonly client: OpenAI
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog

  constructor(deps: IOpenAIChatAdapterDeps = {}) {
    this.client = deps.client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sk-dummy' })
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.OPENAI, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.OPENAI,
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
    // Um turno que morre no meio deixaria um `tool_calls` sem a mensagem `tool`
    // correspondente, e a API recusa a conversa depois disso.
    const checkpoint = history.length

    const { content, warnings } = this.buildUserContent(input)
    history.push({ role: 'user', content })

    const abort = new AbortController()
    record.abort = abort

    yield { type: 'message.started', sessionId, timestamp: new Date() }
    for (const message of warnings) {
      yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message } }
    }

    try {
      const tools = record.tools ? ((await this.catalog?.list(agent.allowedTools)) ?? []) : []

      yield* runManualToolLoop<OpenAI.Chat.ChatCompletionMessageParam>({
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
      console.error('[OpenAIChat] Error:', message)
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
   * A parte do loop que só o GPT sabe fazer: declarar as tools como `function`, remontar
   * os argumentos que chegam fatiados por índice, e escrever chamada e resultado no
   * formato de history do Chat Completions.
   */
  private loopProvider(record: ISessionRecord, sessionId: string): IManualLoopProvider<OpenAI.Chat.ChatCompletionMessageParam> {
    const client = this.client
    const effort = this.toEffort(record.reasoning)

    return {
      async *runTurn(history, tools, signal): AsyncGenerator<IAgentEvent, IManualTurnOutcome> {
        const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: record.model,
          messages: [{ role: 'system', content: record.systemPrompt }, ...history],
          max_completion_tokens: maxOutputTokens(),
          stream: true,
          stream_options: { include_usage: true },
        }

        if (effort) params.reasoning_effort = effort
        if (tools.length > 0) params.tools = tools.map(toOpenAITool)

        const stream = await client.chat.completions.create(params, { signal })

        let text = ''
        const pending = new Map<number, { id: string; name: string; json: string }>()

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta

          if (delta?.content) {
            text += delta.content
            yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: delta.content } }
          }

          for (const part of delta?.tool_calls ?? []) {
            const call = pending.get(part.index) ?? { id: '', name: '', json: '' }
            if (part.id) call.id = part.id
            if (part.function?.name) call.name = part.function.name
            if (part.function?.arguments) call.json += part.function.arguments
            pending.set(part.index, call)
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

        return { text, calls: [...pending.values()].map(toManualCall) }
      },

      appendAssistant(history, outcome) {
        const message: OpenAI.Chat.ChatCompletionMessageParam = {
          role: 'assistant',
          content: outcome.text || null,
        }

        if (outcome.calls.length > 0) {
          message.tool_calls = outcome.calls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }))
        }

        history.push(message)
      },

      appendToolResults(history, results) {
        // No GPT cada resultado é uma mensagem própria, amarrada pelo tool_call_id.
        for (const entry of results) {
          history.push({ role: 'tool', tool_call_id: entry.call.id, content: entry.outcome.result })
        }
      },
    }
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

function toOpenAITool(tool: IToolDefinition): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as unknown as OpenAI.FunctionParameters },
  }
}

function toManualCall(pending: { id: string; name: string; json: string }): IManualToolCall {
  let args: Record<string, unknown> = {}

  try {
    const parsed: unknown = JSON.parse(pending.json || '{}')
    if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
  } catch {
    args = {}
  }

  return { id: pending.id, name: pending.name, args }
}
