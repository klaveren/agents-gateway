import { randomUUID } from 'node:crypto'
import { ICredentialSource } from '@domain/ports/CredentialStore.Port'
import { requireKey } from './support/Keyed.Client'
import { query, type CanUseTool, type EffortLevel, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IFileAttachment, IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { buildClaudeMcpServers, REMOTE_SERVER_NAME } from '@infra/tools/bridges/Claude.ToolBridge'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { composeSystemPrompt, maxToolTurns } from './support/Prompt.Helper'

const DEFAULT_MODEL = 'claude-sonnet-5'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type TImageType = (typeof IMAGE_TYPES)[number]

type TQuery = typeof query

/**
 * O id que o CLI do Claude conhece. É um UUID nosso, plantado via `options.sessionId`
 * no primeiro turno e reapresentado via `options.resume` nos seguintes.
 */
interface IClaudeAgentNative {
  sdkSessionId: string
  started: boolean
}

export interface IClaudeAgentAdapterDeps {
  query?: TQuery
  /**
   * De onde vem a chave em cada turno. Ausente = o subprocesso herda o ambiente, como antes.
   *
   * ⚠️ O CLI do Claude é um SUBPROCESSO: ele não vê a store, só o `env` que recebe. A chave vai em
   * `options.env` a cada turno — é o que faz a troca pela tela valer sem reiniciar.
   */
  credentials?: ICredentialSource
  store?: SessionStore
  catalog?: ToolCatalog
}

/**
 * Lane `agent` do Claude, sobre o `@anthropic-ai/claude-agent-sdk`.
 *
 * Quem conduz o loop agêntico é o SDK — ele fala com um subprocesso `claude` que o
 * pacote entrega junto (~310 MB, uma optionalDependency por plataforma). Não há
 * `while` de tool aqui, e é esse justamente o ponto do experimento.
 */
export class ClaudeAgentAdapter implements IAgentAdapter {
  private readonly query: TQuery
  private readonly store: SessionStore
  private readonly catalog?: ToolCatalog

  private readonly credentials?: ICredentialSource

  constructor(deps: IClaudeAgentAdapterDeps = {}) {
    this.query = deps.query ?? query
    this.credentials = deps.credentials
    this.store = deps.store ?? new SessionStore()
    this.catalog = deps.catalog
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.CLAUDE, EMode.AGENT), {
      agentId: agent.id,
      provider: EProvider.CLAUDE,
      mode: EMode.AGENT,
      model: input.model || DEFAULT_MODEL,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      // O SDK exige um UUID limpo aqui; o id do gateway leva prefixo e não serve.
      native: { sdkSessionId: randomUUID(), started: false },
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

    const native = this.nativeOf(record)
    const abort = new AbortController()
    record.abort = abort

    const { blocks, warnings } = this.buildBlocks(input)

    yield { type: 'message.started', sessionId, timestamp: new Date() }
    for (const message of warnings) {
      yield { type: 'warning', sessionId, timestamp: new Date(), payload: { message } }
    }

    let apiKey: string | undefined
    try {
      apiKey = this.credentials ? requireKey(EProvider.CLAUDE, this.credentials) : undefined
    } catch (error: unknown) {
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message: error instanceof Error ? error.message : String(error) } }
      return
    }

    const local = this.catalog?.localFor(agent.allowedTools) ?? []
    const remoteUrl = await this.catalog?.mcpEndpoint()

    const options: Options = {
      model: record.model,
      systemPrompt: record.systemPrompt,
      // `tools` é só o conjunto de built-ins do Claude Code: vazio significa que o
      // agente não ganha Bash/Read/Edit sobre a máquina do host. As tools que ele de
      // fato tem chegam por `mcpServers`.
      tools: [],
      mcpServers: buildClaudeMcpServers(local, remoteUrl, context.token),
      // Nomes soltos em `allowedTools` aprovam antes de o callback rodar e o SDK
      // avisa que o `canUseTool` foi sombreado; por isso o gate fica só aqui.
      canUseTool: this.makeGate(agent.allowedTools),
      // Isolamento: sem isto o subprocesso lê o ~/.claude e o CLAUDE.md da máquina.
      settingSources: [],
      includePartialMessages: true,
      maxTurns: maxToolTurns(),
      abortController: abort,
      ...(native.started ? { resume: native.sdkSessionId } : { sessionId: native.sdkSessionId }),
      ...(apiKey ? { env: { ...process.env, ANTHROPIC_API_KEY: apiKey } } : {}),
    }

    const effort = this.toEffort(record.reasoning)
    if (effort) options.effort = effort

    const stream = this.query({ prompt: this.buildPrompt(input, blocks), options })

    // O bloco `tool_result` só traz o `tool_use_id`. Sem guardar o nome da chamada, o
    // evento de resultado sairia identificado por um id opaco.
    const toolNames = new Map<string, string>()

    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          // O CLI é a autoridade sobre o id da sessão; adotamos o que ele devolve.
          native.sdkSessionId = message.session_id
          native.started = true
          continue
        }

        if (message.type === 'stream_event') {
          const event = message.event
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text.delta', sessionId, timestamp: new Date(), payload: { text: event.delta.text } }
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'reasoning.delta', sessionId, timestamp: new Date(), payload: { text: event.delta.thinking } }
            }
          }
          continue
        }

        // O texto já saiu pelos deltas; da mensagem inteira só aproveitamos as tools.
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') {
              const tool = this.bareToolName(block.name)
              toolNames.set(block.id, tool)
              yield {
                type: 'tool.started',
                sessionId,
                timestamp: new Date(),
                payload: { tool, args: this.toArgs(block.input) },
              }
            }
          }
          continue
        }

        if (message.type === 'user') {
          const content = message.message.content
          if (typeof content === 'string') continue
          for (const block of content) {
            if (block.type === 'tool_result') {
              const tool = toolNames.get(block.tool_use_id) ?? block.tool_use_id
              yield {
                type: 'tool.result',
                sessionId,
                timestamp: new Date(),
                payload: { tool, result: block.content },
              }
            }
          }
          continue
        }

        if (message.type === 'result') {
          native.started = true

          yield {
            type: 'usage',
            sessionId,
            timestamp: new Date(),
            payload: {
              /**
               * ⚠️ A ENTRADA DO CLAUDE VEM EM TRÊS CAMPOS, e `input_tokens` é o MENOR deles: só o que não
               * passou pelo cache. O que já foi enviado antes vira `cache_read_input_tokens`, o que acabou
               * de entrar no cache vira `cache_creation_input_tokens`. Lendo só o primeiro, uma conversa
               * inteira aparecia com dezenas de tokens de entrada — um número plausível e errado.
               *
               * ⚖️ Somados como entrada porque entrada é o que são, e as duas parcelas saem também
               * SEPARADAS: o preço delas difere (leitura custa uma fração, gravação custa mais).
               */
              inputTokens: message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
              cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
              outputTokens: message.usage.output_tokens,
            },
          }

          if (message.subtype !== 'success' || message.is_error) {
            const detail = message.subtype === 'success' ? message.result : message.errors.join('; ')
            yield {
              type: 'error',
              sessionId,
              timestamp: new Date(),
              payload: { message: detail || `Claude Agent SDK stopped: ${message.subtype}` },
            }
            return
          }
        }
      }

      yield { type: 'message.completed', sessionId, timestamp: new Date() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: new Date() }
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      console.error('[ClaudeAgent] Error:', message)
      yield { type: 'error', sessionId, timestamp: new Date(), payload: { message } }
    } finally {
      record.abort = undefined
      stream.return(undefined).catch(() => undefined)
    }
  }

  /**
   * Deixa passar o que o agente declarou e o que veio do MCP server — quem escolheu
   * subir aquele server foi o operador. Qualquer outra coisa é recusada com motivo.
   */
  /**
   * O store é compartilhado pelos seis adapters, então o slot nativo é `unknown`. Este é o
   * único ponto do adapter que sabe o formato do que ele guardou lá.
   */
  private nativeOf(record: ISessionRecord): IClaudeAgentNative {
    if (!record.native) record.native = { sdkSessionId: randomUUID(), started: false }
    return record.native as IClaudeAgentNative
  }

  /**
   * O nome da tool sem o prefixo do SDK.
   *
   * ⚖️ O SDK do Claude nomeia tool de MCP como `mcp__<servidor>__<tool>`. A execução já tirava isso;
   * o EVENTO não, então o turno gravava o nome cheio e quem agrega contava a mesma tool sob dois
   * nomes. Um ponto só, usado no gate e na emissão, mantém o nome consistente.
   */
  private bareToolName(name: string): string {
    if (!name.startsWith('mcp__')) return name
    const [, , ...rest] = name.split('__')
    return rest.join('__') || name
  }

  private makeGate(allowed: string[]): CanUseTool {
    return async (toolName) => {
      const [, server] = toolName.split('__')
      const isMcp = toolName.startsWith('mcp__')
      const bare = this.bareToolName(toolName)

      if (isMcp && server === REMOTE_SERVER_NAME) return { behavior: 'allow' }
      if (allowed.includes(bare)) return { behavior: 'allow' }

      return { behavior: 'deny', message: `Tool "${bare}" is not enabled for this agent.` }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    // O objeto Query não expõe `.abort()` — o que existe é o AbortController e `.close()`.
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * Sem anexos, um prompt de texto basta. Com anexos é preciso o modo de entrada em
   * streaming, que é o único caminho para mandar blocos `image` e `document`.
   */
  private buildPrompt(input: IMessageInput, blocks: SDKUserMessage['message']['content']): string | AsyncIterable<SDKUserMessage> {
    if (typeof blocks === 'string') return input.text

    async function* once(): AsyncGenerator<SDKUserMessage> {
      yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null }
    }

    return once()
  }

  private buildBlocks(input: IMessageInput): { blocks: SDKUserMessage['message']['content']; warnings: string[] } {
    const files = input.files ?? []
    if (files.length === 0) return { blocks: input.text, warnings: [] }

    // Texto vazio não vira bloco: a API recusa bloco de texto vazio, e anexo sem frase é mensagem válida.
    const blocks: Exclude<SDKUserMessage['message']['content'], string> = input.text.trim() ? [{ type: 'text', text: input.text }] : []
    const warnings: string[] = []

    for (const file of files) {
      if (this.isImageType(file.mimeType)) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mimeType, data: file.data } })
      } else if (file.mimeType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } })
      } else {
        warnings.push(this.unsupported(file))
      }
    }

    return { blocks, warnings }
  }

  private unsupported(file: IFileAttachment): string {
    return `Attachment "${file.name}" (${file.mimeType}) is not supported by Claude and was skipped.`
  }

  private isImageType(mimeType: string): mimeType is TImageType {
    return (IMAGE_TYPES as readonly string[]).includes(mimeType)
  }

  private toArgs(input: unknown): Record<string, unknown> {
    return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  }

  private toEffort(reasoning: string | undefined): EffortLevel | undefined {
    return (EFFORTS as readonly string[]).includes(reasoning ?? '') ? (reasoning as EffortLevel) : undefined
  }
}
