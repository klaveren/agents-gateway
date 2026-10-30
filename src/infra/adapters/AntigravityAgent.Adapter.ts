import { sessionChoice } from '@domain/Agent.Policy'
import { errorPayload } from '@domain/Provider.Failure'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { ITurnTool, TurnGrants, turnGrants } from '@infra/tools/Turn.Grants'
import { IConnectionSource, UnavailableProviderError } from './support/Keyed.Client'
import { composeSystemPrompt, maxToolTurns } from './support/Prompt.Helper'
import { subscriptionEnv, subscriptionHome, workspaceFor } from './support/Subscription.Workspace'

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
  catalog?: ToolCatalog
  /** Onde o `agy` chama as ferramentas do gateway (`/v1/turn-tools`). Ausente = sem terminal nem arquivos. */
  turnTools?: { url: string; grants?: TurnGrants }
}

/** O binário: `ANTIGRAVITY_BIN`, ou `agy` do PATH. */
export function antigravityBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTIGRAVITY_BIN?.trim() || 'agy'
}

const TURN_TIMEOUT_S = 600

/**
 * Os argumentos de um turno.
 *
 * ⛔ SEMPRE `--sandbox` e NUNCA `--dangerously-skip-permissions`: em modo headless, o que pede permissão é negado
 * sozinho. Verificado no `agy` 1.4.5: terminal, escrita e leitura FORA da pasta, negados; leitura DENTRO da pasta,
 * liberada — inclusive o `.env`. Por isso a pasta é sempre a vazia da conversa (ver `sendMessage`). Sem `--sandbox`, o
 * `agy` 0.65 deixou passar um `ls` "inofensivo". `--disable-slash-commands`: a mensagem de quem conversa nunca vira
 * comando do CLI.
 */
export function antigravityArgs(prompt: string, model: string, conversationId?: string): string[] {
  return [
    // ⛔ `-p=<texto>` e não `-p <texto>`: separado, um texto que começa com `--` vira flag do CLI
    // (verificado: `-p "--help"` imprimia a ajuda). Colado, é sempre o valor.
    `-p=${prompt}`,
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
 * regras dela), diretório vazio por conversa, ambiente mínimo. O terminal, os arquivos, as tarefas e os MCPs do agente
 * chegam pelo GATEWAY, num plugin gravado na pasta da conversa a cada turno (ver `writeTurnToolsPlugin`).
 *
 * ⚠️ O CLI não tem flag de system prompt: as instruções do agente vão no PRIMEIRO turno, antes da
 * mensagem; a conversa retomada já as tem.
 */
export class AntigravityAgentAdapter implements IAgentAdapter {
  /** O CLI compacta o próprio contexto (ver `Compaction.Policy`). */
  readonly compactsItself = true
  private readonly store: SessionStore
  private readonly connections?: IConnectionSource
  private readonly spawn: TSpawn
  private readonly home: () => string
  private readonly catalog?: ToolCatalog
  private readonly turnTools?: { url: string; grants?: TurnGrants }

  constructor(deps: IAntigravityAgentAdapterDeps = {}) {
    this.store = deps.store ?? new SessionStore()
    this.connections = deps.connections
    this.spawn = deps.spawn ?? nodeSpawn
    this.home = deps.home ?? (() => subscriptionHome('antigravity'))
    this.catalog = deps.catalog
    this.turnTools = deps.turnTools
  }

  async createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession> {
    const choice = sessionChoice(agent, input)
    const record = this.store.create(sessionPrefix(EProvider.ANTIGRAVITY, EMode.AGENT), {
      agentId: agent.id,
      provider: choice.provider,
      protocol: EProvider.ANTIGRAVITY,
      mode: EMode.AGENT,
      model: choice.model,
      reasoning: input.reasoning,
      language: input.language,
      tools: false,
      systemPrompt: composeSystemPrompt(agent, input),
      metadata: input.metadata,
      native: {},
    })
    return { id: record.id, provider: record.provider, mode: record.mode, createdAt: record.createdAt, metadata: record.metadata }
  }

  async *sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent> {
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
    // ⛔ A pasta VAZIA da conversa, nunca a do projeto: o `agy` lê tudo o que está na pasta dele, sem as permissões do
    // agente (o `.env` inclusive). O projeto chega ao Gemini só pelas ferramentas do gateway, que seguem as permissões.
    const workspace = workspaceFor(undefined, sessionId)
    const tools = await this.turnToolsOf(agent, { ...context, sessionId })
    const grants = this.turnTools?.grants ?? turnGrants()
    const grant = tools.length && this.turnTools && allowTurnTools(home) ? grants.register({ tools, context: { ...context, sessionId } }) : undefined
    if (tools.length && !grant)
      yield { type: 'warning', sessionId, timestamp: now(), payload: { message: 'As ferramentas do gateway não chegam ao Antigravity aqui: ficam de fora.' } }
    const plugin = turnToolsPluginDir(workspace)
    rmSync(plugin, { recursive: true, force: true })
    if (grant) writeTurnToolsPlugin(workspace, this.turnTools!.url, { 'X-Turn-Grant': grant, ...(context.token ? { 'X-Tool-Authorization': `Bearer ${context.token}` } : {}) })
    const child = this.spawn(antigravityBin(), antigravityArgs(prompt, record.model, native.conversationId), {
      cwd: workspace,
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
        yield { type: 'error', sessionId, timestamp: now(), payload: errorPayload(stderr, antigravityFailure(stderr, code)) }
        return
      }
      yield { type: 'message.completed', sessionId, timestamp: now() }
    } catch (error: unknown) {
      if (abort.signal.aborted) {
        yield { type: 'message.aborted', sessionId, timestamp: now() }
        return
      }
      yield { type: 'error', sessionId, timestamp: now(), payload: errorPayload(error) }
    } finally {
      record.abort = undefined
      if (child.exitCode === null) child.kill('SIGTERM')
      if (grant) grants.release(grant)
      rmSync(plugin, { recursive: true, force: true })
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.store.get(sessionId)?.abort?.abort()
  }

  /**
   * ⛔ TUDO PELO GATEWAY: as locais e as dos MCPs que o agente escolheu, pela caixa dele (`toolbox`). O `agy` só fala com
   * o `/v1/turn-tools`: nunca recebe a URL nem a credencial de um MCP, e cada chamada passa de novo pelas permissões.
   */
  private async turnToolsOf(agent: IAgent, context: IExecutionContext): Promise<ITurnTool[]> {
    if (!this.catalog || !this.turnTools) return []
    const box = await this.catalog.toolbox(agent.allowedTools, context)
    return box.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: (args, callContext) => box.invoke(tool.name, args, callContext),
    }))
  }

  private nativeOf(record: ISessionRecord): IAntigravityNative {
    if (!record.native) record.native = {}
    return record.native as IAntigravityNative
  }
}

/** O plugin e o servidor do gateway: o `agy` junta os dois no nome do servidor (`gateway_tools`). */
const TURN_TOOLS_PLUGIN = 'gateway'
const TURN_TOOLS_SERVER = 'tools'
export const ANTIGRAVITY_TURN_TOOLS_SERVER = `${TURN_TOOLS_PLUGIN}_${TURN_TOOLS_SERVER}`
const ALLOW_TURN_TOOLS = `mcp(${ANTIGRAVITY_TURN_TOOLS_SERVER}/*)`

export function turnToolsPluginDir(workspace: string): string {
  return join(workspace, '.agents', 'plugins', TURN_TOOLS_PLUGIN)
}

/**
 * ⛔ O MCP DO GATEWAY POR CONVERSA: o `agy` só tem MCP da instalação inteira (`~/.gemini/config`) e o dos plugins da
 * pasta (`<pasta>/.agents/plugins/<nome>/mcp_config.json`). O plugin vai na pasta VAZIA da conversa, com o token do turno
 * (`Turn.Grants`), e sai no fim do turno. Verificado no `agy` 1.4.9: ele conecta e manda os headers.
 */
export function writeTurnToolsPlugin(workspace: string, url: string, headers: Record<string, string>): string {
  const dir = turnToolsPluginDir(workspace)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: TURN_TOOLS_PLUGIN, version: '1.0.0', description: 'As ferramentas do gateway nesta conversa.' }), { mode: 0o600 })
  writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { [TURN_TOOLS_SERVER]: { url, headers } } }), { mode: 0o600 })
  return dir
}

/**
 * ⛔ A LIBERAÇÃO DAS CHAMADAS: no modo headless, o `agy` nega toda chamada de MCP sem regra `mcp(<servidor>/<ferramenta>)`
 * no `settings.json` do HOME. A regra libera SÓ o servidor do gateway (quem decide cada chamada são as permissões do
 * agente, no gateway) e só se grava no HOME DO GATEWAY: no macOS o HOME é o da pessoa (o Keychain, ver
 * `subscriptionHome`), e lá o gateway não escreve; o Gemini fica sem as ferramentas. Um `settings.json` que não é JSON
 * também fica como está.
 */
export function allowTurnTools(home: string): boolean {
  if (resolve(home) === resolve(homedir())) return false
  const file = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  try {
    const settings = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {}
    const permissions = isRecord(settings.permissions) ? settings.permissions : {}
    const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : []
    if (allow.includes(ALLOW_TURN_TOOLS)) return true
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify({ ...settings, permissions: { ...permissions, allow: [...allow, ALLOW_TURN_TOOLS] } }, null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A falha sem resultado, com a correção quando é o login. */
export function antigravityFailure(stderr: string, code: number | null): string {
  if (/Authentication required|authentication failed/i.test(stderr)) return 'O Antigravity não está conectado: entre em Sistema → Modelos → Antigravity → Entrar.'
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
    if (result.status && result.status !== 'SUCCESS')
      events.push({ type: 'error', sessionId, timestamp, payload: errorPayload(result.error || result.status || '', result.error || `Antigravity: ${result.status}`) })
    return events
  }
  return []
}
