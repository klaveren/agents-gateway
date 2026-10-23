import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { sessionPrefix } from '@infra/session/Session.Key'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'
import { IConnectionSource, UnavailableProviderError } from './support/Keyed.Client'
import { composeSystemPrompt, maxToolTurns } from './support/Prompt.Helper'
import { sessionWorkspace, subscriptionEnv, subscriptionHome } from './support/Subscription.Workspace'

type TSpawn = typeof nodeSpawn

/** O id da conversa que o `agy` devolve no `init` — é por ele que os turnos seguintes retomam. */
interface IAntigravityNative {
  conversationId?: string
}

export interface IAntigravityAgentAdapterDeps {
  store?: SessionStore
  connections?: IConnectionSource
  /** Injetável para o teste não subir o binário. */
  spawn?: TSpawn
  home?: () => string
}

/** O binário: `ANTIGRAVITY_BIN`, ou `agy` do PATH. */
export function antigravityBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_BIN?.trim() || 'agy'
}

const TURN_TIMEOUT_S = 600

/**
 * Os argumentos de um turno.
 *
 * ⛔ SEMPRE `--sandbox` e NUNCA `--dangerously-skip-permissions`: em modo headless, o que pede
 * permissão (comando, leitura de arquivo) é negado sozinho; sem `--sandbox`, o `agy` 0.65 deixou passar
 * um `ls` "inofensivo" — verificado. `--disable-slash-commands`: a mensagem de quem conversa nunca vira
 * comando do CLI.
 */
export function antigravityArgs(prompt: string, model: string, conversationId?: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--print-timeout',
    `${TURN_TIMEOUT_S}s`,
    '--sandbox',
    '--disable-slash-commands',
    ...(model ? ['--model', model] : []),
    ...(conversationId ? ['--conversation', conversationId] : []),
  ]
}

/**
 * Lane `agent` do Google pela ASSINATURA, sobre o Antigravity CLI (`agy -p --output-format stream-json`).
 *
 * ⛔ HOME próprio do gateway (o login feito pela tela; nunca o `~/.gemini` da pessoa, com os MCPs e as
 * regras dela), diretório vazio por conversa, ambiente mínimo. ⚠️ Sem MCP nesta versão: o `agy mcp` é
 * da instalação inteira, não por conversa — misturaria um cliente com outro.
 *
 * ⚠️ O CLI não tem flag de system prompt: as instruções do agente vão no PRIMEIRO turno, antes da
 * mensagem; a conversa retomada já as tem.
 */
export class AntigravityAgentAdapter implements IAgentAdapter {
  private readonly store: SessionStore
  private readonly connections?: IConnectionSource
  private readonly spawn: TSpawn
  private readonly home: () => string

  constructor(deps: IAntigravityAgentAdapterDeps = {}) {
    this.store = deps.store ?? new SessionStore()
    this.connections = deps.connections
    this.spawn = deps.spawn ?? nodeSpawn
    this.home = deps.home ?? (() => subscriptionHome('antigravity'))
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const record = this.store.create(sessionPrefix(EProvider.ANTIGRAVITY, EMode.AGENT), {
      agentId: agent.id,
      provider: agent.provider,
      protocol: EProvider.ANTIGRAVITY,
      mode: EMode.AGENT,
      model: input.model || agent.models[0] || '',
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      native: {},
    })
    return { id: record.id, provider: record.provider, mode: record.mode, createdAt: record.createdAt, metadata: record.metadata }
  }

  async *sendMessage(_agent: IAgent, sessionId: string, input: IMessageInput, _context: IExecutionContext): AsyncIterable<IAgentEvent> {
    const now = () => new Date()
    const record = this.store.get(sessionId)
    if (!record) {
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: `Session not found: ${sessionId}` } }
      return
    }
    if (this.connections && !this.connections.connection(record.provider)) {
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: new UnavailableProviderError(record.provider).message } }
      return
    }

    const native = this.nativeOf(record)
    const abort = new AbortController()
    record.abort = abort
    yield { type: 'message.started', sessionId, timestamp: now() }
    if (input.files?.length) yield { type: 'warning', sessionId, timestamp: now(), payload: { message: 'O Antigravity não recebe anexos por aqui: eles ficaram de fora.' } }

    const prompt = native.conversationId ? input.text : `${record.systemPrompt}\n\n---\n\n${input.text}`
    const home = this.home()
    const child = this.spawn(antigravityBin(), antigravityArgs(prompt, record.model, native.conversationId), {
      cwd: sessionWorkspace(sessionId),
      env: subscriptionEnv({ HOME: home }),
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: abort.signal,
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)))
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code))
      child.on('error', () => resolve(null))
    })

    const state: IAntigravityTurn = { native, toolSteps: new Set(), sawResult: false, turns: 0 }
    try {
      for await (const line of createInterface({ input: child.stdout! })) {
        for (const event of antigravityEvents(line, sessionId, state)) {
          yield event
          if (event.type === 'error') return
        }
        if (state.turns > maxToolTurns()) {
          child.kill('SIGTERM')
          yield { type: 'error', sessionId, timestamp: now(), payload: { message: `Antigravity passed ${maxToolTurns()} tool steps.` } }
          return
        }
      }
      const code = await exited
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: now() }
        return
      }
      if (!state.sawResult) {
        yield { type: 'error', sessionId, timestamp: now(), payload: { message: antigravityFailure(stderr, code) } }
        return
      }
      yield { type: 'message.completed', sessionId, timestamp: now() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: now() }
        return
      }
      yield { type: 'error', sessionId, timestamp: now(), payload: { message: error instanceof Error ? error.message : String(error) } }
    } finally {
      record.abort = undefined
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  private nativeOf(record: ISessionRecord): IAntigravityNative {
    if (!record.native) record.native = {}
    return record.native as IAntigravityNative
  }
}

/** A falha sem resultado, com a correção quando é o login. */
export function antigravityFailure(stderr: string, code: number | null): string {
  if (/Authentication required|authentication failed/i.test(stderr)) return 'O Antigravity não está conectado: entre em Providers → Antigravity (assinatura) → Entrar.'
  if (code === null) return `Não consegui rodar o Antigravity (${antigravityBin()}). Instale o agy ou defina ANTIGRAVITY_BIN.`
  return stderr.trim().split('\n').slice(-3).join(' ') || `agy saiu com código ${code}`
}

interface IAntigravityTurn {
  native: IAntigravityNative
  /** Os passos de ferramenta já anunciados (o `agy` manda o mesmo passo como ACTIVE e depois DONE). */
  toolSteps: Set<number>
  sawResult: boolean
  turns: number
}

interface IAgyLine {
  event?: string
  conversation_id?: string
  init?: unknown
  step_update?: {
    step_index?: number
    state?: string
    step_type?: string
    text_delta?: string
    thinking_delta?: string
    tool_name?: string
    tool_info?: { parameters?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
  }
  result?: {
    status?: string
    error?: string
    response?: string
    usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number }
    denied_actions?: Array<{ action?: string; display_name?: string }>
  }
}

/** Uma linha do NDJSON do `agy` nos eventos do gateway. Linha que não é JSON é ignorada. */
export function antigravityEvents(line: string, sessionId: string, state: IAntigravityTurn): IAgentEvent[] {
  let parsed: IAgyLine
  try {
    parsed = JSON.parse(line) as IAgyLine
  } catch {
    return []
  }
  const timestamp = new Date()

  if (parsed.event === 'init') {
    if (parsed.conversation_id) state.native.conversationId = parsed.conversation_id
    return []
  }

  const step = parsed.step_update
  if (parsed.event === 'step_update' && step) {
    if (step.step_type === 'agent_response') {
      const events: IAgentEvent[] = []
      if (step.thinking_delta) events.push({ type: 'reasoning.delta', sessionId, timestamp, payload: { text: step.thinking_delta } })
      if (step.text_delta) events.push({ type: 'text.delta', sessionId, timestamp, payload: { text: step.text_delta } })
      return events
    }
    if (step.step_type === 'tool' && step.tool_name) {
      const index = step.step_index ?? -1
      const events: IAgentEvent[] = []
      if (!state.toolSteps.has(index)) {
        state.toolSteps.add(index)
        state.turns += 1
        events.push({ type: 'tool.started', sessionId, timestamp, payload: { tool: step.tool_name, args: step.tool_info?.parameters ?? {} } })
      }
      if (step.state === 'DONE') events.push({ type: 'tool.result', sessionId, timestamp, payload: { tool: step.tool_name, result: step.tool_info?.result ?? null } })
      if (step.state === 'ERROR')
        events.push({ type: 'tool.error', sessionId, timestamp, payload: { tool: step.tool_name, message: step.tool_info?.error?.message?.split('\n')[0] ?? 'tool failed' } })
      return events
    }
    return []
  }

  if (parsed.event === 'result' && parsed.result) {
    state.sawResult = true
    const result = parsed.result
    const events: IAgentEvent[] = []
    if (result.usage) {
      events.push({
        type: 'usage',
        sessionId,
        timestamp,
        payload: {
          inputTokens: result.usage.input_tokens ?? 0,
          cacheReadTokens: result.usage.cache_read_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          reasoningTokens: result.usage.thinking_tokens ?? 0,
        },
      })
    }
    const denied = (result.denied_actions ?? []).map((action) => action.display_name ?? action.action).filter(Boolean)
    if (denied.length) events.push({ type: 'warning', sessionId, timestamp, payload: { message: `Negado pelo sandbox: ${denied.join(', ')}.` } })
    if (result.status && result.status !== 'SUCCESS') events.push({ type: 'error', sessionId, timestamp, payload: { message: result.error || `Antigravity: ${result.status}` } })
    return events
  }
  return []
}
