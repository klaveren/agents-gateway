import { ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Codex, CodexOptions } from '@openai/codex-sdk'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IListedModel } from '@domain/models/ModelCatalog.Model'
import { IModelPrice, MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { REASONING_LEVELS } from '@domain/Reasoning.Levels'
import { antigravityBin } from '@infra/adapters/AntigravityAgent.Adapter'
import { CODEX_LOCKED_FEATURES } from '@infra/adapters/CodexAgent.Adapter'
import { claudeBinary } from '@infra/adapters/support/Claude.Binary'
import { codexBinary, untestedCodex } from '@infra/adapters/support/Codex.Binary'
import { esmImport } from '@infra/adapters/support/Esm.Import'
import { subscriptionEnv, subscriptionHome } from '@infra/adapters/support/Subscription.Workspace'
import { IProbeResult } from './Provider.Probe'

const run = promisify(execFile)

/**
 * O que a tela de Providers faz com uma ASSINATURA: listar modelos, testar e entrar na conta.
 *
 * ⚖️ Nenhum deles tem uma API de listagem com chave: cada um sabe os modelos do seu jeito — o Claude
 * por uma lista fixa, o Codex pelo `models_cache.json` que ele mesmo grava, o Antigravity por `agy models`.
 */

const CLAUDE_SUB_MODELS: ReadonlyArray<[string, string]> = [
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
]

const CODEX_FALLBACK = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']

/**
 * ⚖️ O PREÇO DA API, MESMO NA ASSINATURA: a conta não cobra por token, mas o número mostra quanto a
 * conversa custaria em tokens de verdade — a medida de quanto a assinatura está rendendo.
 *
 * O id da assinatura nem sempre é o da tabela: o Antigravity põe o nível no fim (`-high`), e versões
 * novas (`claude-opus-5-5`) herdam o preço da família mais próxima (`claude-opus-5`). Sem nada parecido,
 * sem preço — "sem preço" nunca vira zero.
 */
export function equivalentPrice(modelId: string, pricing: TModelPricing = MODEL_PRICING): IModelPrice | undefined {
  const base = modelId.replace(/-(low|medium|high|max|xhigh)$/, '')
  for (const candidate of [modelId, base]) if (Object.hasOwn(pricing, candidate)) return pricing[candidate]
  const family = Object.keys(pricing)
    .filter((key) => base.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  return family ? pricing[family] : undefined
}

export async function listSubscriptionModels(protocol: EProvider, pricing: TModelPricing = MODEL_PRICING): Promise<IListedModel[]> {
  const priced = (item: IListedModel): IListedModel => {
    const price = equivalentPrice(item.id, pricing)
    return price ? { ...item, price } : item
  }

  if (protocol === EProvider.CLAUDE_SUB) {
    return CLAUDE_SUB_MODELS.map(([id, label]) => priced({ id, label, reasoning: { supported: true, levels: [...REASONING_LEVELS[EProvider.CLAUDE_SUB]], source: 'provider' } }))
  }
  if (protocol === EProvider.CODEX) return codexModels().map(priced)
  if (protocol === EProvider.ANTIGRAVITY) return (await antigravityModels()).map(priced)
  throw new Error(`${protocol} is not a subscription protocol`)
}

/** O cache que o Codex grava ao rodar (no HOME do gateway, ou o da pessoa); senão a lista de reserva. */
function codexModels(): IListedModel[] {
  for (const file of [join(subscriptionHome('codex'), 'models_cache.json'), join(homedir(), '.codex', 'models_cache.json')]) {
    if (!existsSync(file)) continue
    try {
      const cache = JSON.parse(readFileSync(file, 'utf8')) as {
        models?: Array<{ slug: string; display_name?: string; visibility?: string; context_window?: number; supported_reasoning_levels?: Array<{ effort: string }> }>
      }
      const models = (cache.models ?? []).filter((model) => model.visibility === 'list')
      if (!models.length) continue
      return models.map((model) => {
        const levels = (model.supported_reasoning_levels ?? []).map((level) => level.effort).filter((level) => REASONING_LEVELS[EProvider.CODEX].includes(level))
        return { id: model.slug, label: model.display_name, contextLength: model.context_window, reasoning: { supported: levels.length > 0, levels, source: 'provider' } }
      })
    } catch {
      // Cache ilegível: tenta o próximo.
    }
  }
  return CODEX_FALLBACK.map((id) => ({ id }))
}

/** `agy models`: uma linha por modelo, `id<TAB>rótulo`. O nível vem no id (ver `REASONING_LEVELS`). */
async function antigravityModels(): Promise<IListedModel[]> {
  const home = subscriptionHome('antigravity')
  const { stdout } = await run(antigravityBin(), ['models'], { cwd: home, env: subscriptionEnv({ HOME: home }), timeout: 30_000 })
  return stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter(([id, label]) => id && label && /^[a-z0-9][a-z0-9.-]+$/.test(id.trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim(), reasoning: { supported: false, levels: [], source: 'provider' as const } }))
}

/**
 * "Testar" de uma assinatura: um turno mínimo pelo MESMO cliente que as conversas usam, com o mesmo
 * isolamento. É a única prova de que o login vale — nenhum deles tem uma chamada barata de "quem sou eu".
 */
export async function probeSubscription(protocol: EProvider, token?: string): Promise<IProbeResult> {
  const workspace = mkdtempSync(join(tmpdir(), 'gateway-sub-probe-'))
  try {
    const reply = await Promise.race([
      probeTurn(protocol, workspace, token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('a assinatura não respondeu em 90 s')), 90_000)),
    ])
    return { ok: true, message: `Respondeu: ${reply.trim().slice(0, 80)}` }
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

const PROBE_PROMPT = 'Responda apenas: ok'

async function probeTurn(protocol: EProvider, workspace: string, token?: string): Promise<string> {
  if (protocol === EProvider.CLAUDE_SUB) {
    let text = ''
    for await (const message of query({
      prompt: PROBE_PROMPT,
      options: {
        cwd: workspace,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env: subscriptionEnv({ HOME: homedir(), CLAUDE_CODE_OAUTH_TOKEN: token, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }),
      },
    })) {
      if (message.type !== 'result') continue
      if (message.subtype !== 'success' || message.is_error)
        throw new Error(
          (message.subtype === 'success' ? message.result : message.errors.join('; ')) ||
            'o Claude recusou o login: entre com `claude login` no computador do gateway ou cole um token',
        )
      text = message.result
    }
    return text
  }

  if (protocol === EProvider.CODEX) {
    const home = subscriptionHome('codex')
    if (!existsSync(join(home, 'auth.json'))) throw new Error('O ChatGPT não está conectado: use Entrar.')
    const untested = untestedCodex()
    if (untested) throw new Error(untested)
    const Codex = (await esmImport<{ Codex: new (options?: CodexOptions) => Codex }>('@openai/codex-sdk')).Codex
    const codex = new Codex({
      env: subscriptionEnv({ HOME: workspace, CODEX_HOME: home }),
      config: {
        features: { ...CODEX_LOCKED_FEATURES },
        // ⛔ Login em ARQUIVO no CODEX_HOME do gateway, nunca no Keychain da pessoa.
        cli_auth_credentials_store: 'file',
      },
    })
    const thread = codex.startThread({
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    })
    const result = await thread.run(PROBE_PROMPT)
    return result.finalResponse
  }

  if (protocol === EProvider.ANTIGRAVITY) {
    const home = subscriptionHome('antigravity')
    const { stdout } = await run(antigravityBin(), [`-p=${PROBE_PROMPT}`, '--output-format', 'json', '--print-timeout', '60s', '--sandbox'], {
      cwd: workspace,
      env: subscriptionEnv({ HOME: home }),
      timeout: 90_000,
    }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
      if (/Authentication required/i.test(`${error.stdout}${error.stderr}`)) throw new Error('O Antigravity não está conectado: use Entrar.')
      throw new Error(error.stderr?.trim().split('\n').pop() || error.message)
    })
    const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { status?: string; response?: string; error?: string }
    if (result.status !== 'SUCCESS') throw new Error(result.error || 'o Antigravity não respondeu')
    return result.response ?? ''
  }

  throw new Error(`${protocol} is not a subscription protocol`)
}

/** O que a tela mostra de um login em andamento. */
export interface ISubscriptionLoginView {
  state: 'idle' | 'waiting' | 'done' | 'failed'
  /** Abrir no navegador. */
  url?: string
  /** O código de dispositivo para digitar na página (Codex). */
  userCode?: string
  /** A página devolve um código que se cola de volta aqui (Antigravity). */
  needsCode: boolean
  expiresAt?: string
  message?: string
  /** O cliente não está nesta máquina: a tela mostra como instalar, em vez de um erro. */
  missing?: boolean
}

export interface ILoginOptions {
  /** O login que termina num TOKEN (Claude): quem o guarda — no cofre, cifrado. ⛔ Ele não vai para a tela. */
  onToken?: (token: string) => void
}

interface ILoginRun {
  child: ChildProcess
  view: ISubscriptionLoginView
  output: string
  /** O token que o login do Claude imprimiu — só até ir para o cofre. */
  token?: string
  /** O fim da saída, sem máscara, só para achar um token partido entre dois pedaços. */
  tail: string
}

// eslint-disable-next-line no-control-regex -- é exatamente o ESC das cores de terminal
const ANSI = /\u001b\[[0-9;?]*[a-zA-Z]/g
/** O hiperlink de terminal (OSC 8): `ESC ] 8 ; ; <url> BEL`. O Claude Code entrega o link do login assim, inteiro. */
// eslint-disable-next-line no-control-regex -- os bytes ESC e BEL do OSC 8
const OSC8_URL = /\u001b\]8;[^;]*;(https:\/\/[^\u0007\u001b]+)/
// eslint-disable-next-line no-control-regex -- o resto das sequências OSC, para limpar a saída
const OSC = /\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g
/** O token de um ano do `claude setup-token`. ⛔ Nunca sai do servidor: vai para o cofre e some da saída guardada. */
const CLAUDE_TOKEN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}/

/** O que cada login procura na saída do cliente: o link a abrir e, no Codex, o código de dispositivo. */
const LOGIN_URL: Partial<Record<EProvider, RegExp>> = {
  [EProvider.CODEX]: /https:\/\/auth\.openai\.com\/\S+/,
  [EProvider.ANTIGRAVITY]: /https:\/\/accounts\.google\.com\/\S+/,
  [EProvider.CLAUDE_SUB]: /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\S+/,
}

/**
 * O login de uma assinatura pela TELA: o gateway roda o login oficial do cliente, num HOME só dele, e
 * repassa o link (e o código) para quem administra — que entra no navegador e, se for o caso, cola o
 * código de volta.
 *
 * ⚖️ Um login por protocolo de cada vez: começar de novo encerra o anterior. ⛔ O que sai do processo
 * fica no servidor; a tela recebe só link, código de dispositivo e estado.
 */
export class SubscriptionLogins {
  private readonly runs = new Map<EProvider, ILoginRun>()

  constructor(private readonly spawner: typeof spawn = spawn) {}

  view(protocol: EProvider): ISubscriptionLoginView {
    return this.runs.get(protocol)?.view ?? { state: 'idle', needsCode: false }
  }

  async start(protocol: EProvider, options: ILoginOptions = {}): Promise<ISubscriptionLoginView> {
    this.cancel(protocol)
    if (protocol === EProvider.ANTIGRAVITY && !onPath(antigravityBin())) {
      const view: ISubscriptionLoginView = { state: 'failed', needsCode: false, missing: true, message: `O Antigravity CLI (${antigravityBin()}) não está nesta máquina.` }
      return view
    }
    const { command, args, home, needsCode, ttlMs } = loginCommand(protocol)
    const child = this.spawner(command, args, {
      cwd: home,
      env: subscriptionEnv({ HOME: home, CODEX_HOME: protocol === EProvider.CODEX ? home : undefined, NO_COLOR: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Grupo próprio: cancelar mata o `sh`, o `script` e o cliente juntos.
      detached: true,
    })
    const current: ILoginRun = { child, output: '', tail: '', view: { state: 'waiting', needsCode, expiresAt: new Date(Date.now() + ttlMs).toISOString() } }
    this.runs.set(protocol, current)

    const seen = new Promise<void>((resolve) => {
      const read = (chunk: Buffer) => {
        const raw = chunk.toString()
        // O link inteiro vem no hiperlink do terminal; o texto visível pode estar quebrado em linhas.
        current.view.url ??= OSC8_URL.exec(raw)?.[1]
        const text = raw.replace(OSC, '').replace(ANSI, '')
        // O token pode chegar partido em dois pedaços: procura no fim do anterior + este.
        current.tail = (current.tail + text).slice(-600)
        const token = CLAUDE_TOKEN.exec(current.tail)?.[0]
        // ⛔ O token não fica na saída guardada (ela vira mensagem de erro).
        if (token) current.token = token
        current.output = (current.output + text.replace(new RegExp(CLAUDE_TOKEN.source, 'g'), '[token]')).slice(-20_000)
        current.view.url ??= LOGIN_URL[protocol]?.exec(current.output)?.[0]
        if (protocol === EProvider.CODEX) current.view.userCode ??= current.output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0]
        if (current.view.url && (protocol !== EProvider.CODEX || current.view.userCode)) resolve()
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.on('close', () => resolve())
      setTimeout(resolve, 20_000)
    })

    child.on('error', (error) => Object.assign(current.view, { state: 'failed', message: error.message }))
    child.on('close', (code) => {
      if (current.view.state !== 'waiting') return
      let ok = protocol === EProvider.ANTIGRAVITY ? /"status"\s*:\s*"SUCCESS"/.test(current.output) : code === 0
      if (protocol === EProvider.CLAUDE_SUB) {
        ok = !!current.token
        if (current.token) {
          try {
            options.onToken?.(current.token)
          } catch {
            ok = false
          }
          current.token = undefined
        }
      }
      Object.assign(current.view, ok ? { state: 'done', message: 'Conectado.' } : { state: 'failed', message: loginFailure(current.output, code) })
    })

    await seen
    return current.view
  }

  /** O código que a página de login devolveu (Antigravity), direto para o processo que espera. */
  submit(protocol: EProvider, code: string): ISubscriptionLoginView {
    const current = this.runs.get(protocol)
    if (!current || current.view.state !== 'waiting' || !current.view.needsCode) return this.view(protocol)
    // Num pseudo-terminal, o Enter é `\r`.
    current.child.stdin?.write(`${code.trim()}\r`)
    return current.view
  }

  cancel(protocol: EProvider): void {
    const current = this.runs.get(protocol)
    if (current?.child.exitCode === null && current.child.pid) {
      try {
        process.kill(-current.child.pid, 'SIGTERM')
      } catch {
        current.child.kill('SIGTERM')
      }
    }
    this.runs.delete(protocol)
  }
}

function loginCommand(protocol: EProvider): { command: string; args: string[]; home: string; needsCode: boolean; ttlMs: number } {
  if (protocol === EProvider.CODEX)
    return {
      command: codexBinary(),
      args: ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth'],
      home: subscriptionHome('codex'),
      needsCode: false,
      ttlMs: 15 * 60_000,
    }
  if (protocol === EProvider.ANTIGRAVITY) {
    // O login do `agy` acontece no primeiro uso: um turno mínimo que, sem conta, pede para entrar.
    // ⚠️ Só com TERMINAL: sem TTY ele recusa ("Run 'agy' to log in"). O `script` dá um pseudo-terminal.
    const agy = [antigravityBin(), `-p=${PROBE_PROMPT}`, '--output-format', 'json', '--print-timeout', '120s', '--sandbox']
    return { ...inTerminal(agy), home: subscriptionHome('antigravity'), needsCode: true, ttlMs: 60_000 }
  }
  if (protocol === EProvider.CLAUDE_SUB) {
    // `claude setup-token`: o login da conta Claude que termina num token de um ano. Também só com TERMINAL.
    return { ...inTerminal([claudeBinary(), 'setup-token']), home: subscriptionHome('claude'), needsCode: true, ttlMs: 10 * 60_000 }
  }
  throw new Error(`${protocol} has no login here`)
}

/**
 * Um comando num PSEUDO-TERMINAL, largo (400 colunas, para link e token não quebrarem de linha).
 * macOS: o `script` não aceita socket como entrada (o `stdin` do Node é um), então o `cat` põe um pipe no
 * meio. Linux: o `script` do util-linux, com `-e` para devolver o código de saída do comando.
 */
export function inTerminal(argv: readonly string[], platform: string = process.platform): { command: string; args: string[] } {
  const wide = `stty cols 400 rows 50 2>/dev/null; exec ${argv.map(shellQuote).join(' ')}`
  return platform === 'darwin'
    ? { command: '/bin/sh', args: ['-c', 'cat | script -q /dev/null /bin/sh -c "$1"', 'sh', wide] }
    : { command: 'script', args: ['-qfec', wide, '/dev/null'] }
}

/** O binário existe: caminho absoluto, ou algum diretório do PATH. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (command.includes('/')) return existsSync(command)
  return (env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, command)))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function loginFailure(output: string, code: number | null): string {
  if (/timed out/i.test(output)) return 'O tempo do login acabou. Comece de novo.'
  return output.trim().split('\n').slice(-2).join(' ').slice(0, 300) || `o login saiu com código ${code}`
}
