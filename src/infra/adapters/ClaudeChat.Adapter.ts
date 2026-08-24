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
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { IToolDefinition } from '@infra/tools/Tool.Types'
import { IManualLoopProvider, IManualToolCall, IManualToolResult, IManualTurnOutcome, runManualToolLoop } from './support/ManualTool.Loop'
import { composeSystemPrompt, maxOutputTokens, maxToolTurns } from './support/Prompt.Helper'

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
  catalog?: ToolCatalog
}

/**
 * Lane `chat` do Claude, sobre o SDK normal.
 *
 * Por padrão é conversa pura. Com `tools: true` na sessão, o turno passa pelo loop escrito
 * à mão em `support/ManualTool.Loop` — e é aí que dá para comparar, no código, o que a
 * lane `agent` recebe pronto do Agents SDK.
 */
export class ClaudeChatAdapter implements IAgentAdapter {
  private readonly client: Anthropic
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog

  constructor(deps: IClaudeChatAdapterDeps = {}) {
    this.client = deps.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'sk-ant-dummy' })
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.CLAUDE, EMode.CHAT), {
      agentId: agent.id,
      provider: EProvider.CLAUDE,
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
    // Um turno que morre no meio pode deixar um `tool_use` sem resposta, e a Messages API
    // recusa a conversa inteira depois disso. Voltar ao ponto de partida é mais barato que
    // remendar o transcript.
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

      yield* runManualToolLoop<Anthropic.MessageParam>({
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
   * A parte do loop que só o Claude sabe fazer: declarar as tools, achar o `tool_use` no
   * meio do stream e escrever chamada e resultado no formato de history da Messages API.
   */
  private loopProvider(record: ISessionRecord, sessionId: string): IManualLoopProvider<Anthropic.MessageParam> {
    const client = this.client
    const effort = this.toEffort(record.reasoning)

    return {
      async *runTurn(history, tools, signal): AsyncGenerator<IAgentEvent, IManualTurnOutcome> {
        const params: Anthropic.MessageCreateParamsStreaming = {
          model: record.model,
          system: record.systemPrompt,
          max_tokens: maxOutputTokens(),
          messages: [...history],
          stream: true,
        }

        if (effort) params.output_config = { effort }
        if (tools.length > 0) params.tools = tools.map(toAnthropicTool)

        const stream = await client.messages.create(params, { signal })

        let text = ''
        // Os argumentos chegam em pedaços de JSON, indexados pelo bloco de conteúdo.
        const pending = new Map<number, { id: string; name: string; json: string }>()

        for await (const chunk of stream) {
          if (chunk.type === 'message_start') {
            yield {
              type: 'usage',
              sessionId,
              timestamp: new Date(),
              payload: { inputTokens: chunk.message.usage.input_tokens },
            }
          } else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
            pending.set(chunk.index, { id: chunk.content_block.id, name: chunk.content_block.name, json: '' })
          } else if (chunk.type === 'content_block_delta') {
            if (chunk.delta.type === 'text_delta') {
              text += chunk.delta.text
              yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: chunk.delta.text } }
            } else if (chunk.delta.type === 'thinking_delta') {
              yield { type: 'reasoning.delta', sessionId, timestamp: new Date(), payload: { text: chunk.delta.thinking } }
            } else if (chunk.delta.type === 'input_json_delta') {
              const call = pending.get(chunk.index)
              if (call) call.json += chunk.delta.partial_json
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

        return { text, calls: [...pending.values()].map(toManualCall) }
      },

      appendAssistant(history, outcome) {
        const content: Anthropic.ContentBlockParam[] = []
        if (outcome.text) content.push({ type: 'text', text: outcome.text })
        for (const call of outcome.calls) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
        }

        // A Messages API recusa conteúdo vazio.
        history.push({ role: 'assistant', content: content.length > 0 ? content : [{ type: 'text', text: '…' }] })
      },

      appendToolResults(history, results) {
        // No Claude o resultado da tool volta como mensagem do usuário.
        history.push({ role: 'user', content: results.map(toToolResultBlock) })
      },
    }
  }

  private historyOf(record: ISessionRecord): THistory {
    if (!record.native) record.native = [] satisfies THistory
    return record.native as THistory
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

function toAnthropicTool(tool: IToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as unknown as Anthropic.Tool['input_schema'],
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

function toToolResultBlock(entry: IManualToolResult): Anthropic.ContentBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: entry.call.id,
    content: entry.outcome.result,
    is_error: entry.outcome.status === 'error',
  }
}
