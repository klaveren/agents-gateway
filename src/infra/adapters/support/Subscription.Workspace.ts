import { mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'

/**
 * Onde os clientes de ASSINATURA (Codex, Antigravity, Claude Code) rodam.
 *
 * ⛔ CADA CONVERSA NUM DIRETÓRIO VAZIO: esses clientes são agentes de código e tomam o `cwd` como o
 * projeto. Vazio, não há o que ler nem onde escrever; e duas conversas nunca dividem o mesmo.
 */
export function sessionWorkspace(sessionId: string, root = workspacesRoot()): string {
  const dir = join(root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'))
  // ⛔ 0700: o `/tmp` é de todos os usuários da máquina; a pasta de uma conversa é só do gateway.
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function removeSessionWorkspace(sessionId: string, root = workspacesRoot()): void {
  rmSync(join(root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')), { recursive: true, force: true })
}

/** No boot: o que sobrou de uma execução anterior. */
export function clearSessionWorkspaces(root = workspacesRoot()): void {
  rmSync(root, { recursive: true, force: true })
}

function workspacesRoot(): string {
  return join(tmpdir(), 'gateway-sub')
}

/**
 * ⛔ O HOME PRÓPRIO DO GATEWAY para Codex e Antigravity, ao lado do banco (`<dados>/codex-home`,
 * `<dados>/antigravity-home`; no macOS o Antigravity é exceção, ver abaixo). O HOME da pessoa traz a configuração DELA — MCPs locais (um `node_repl`
 * que lê o disco), conectores, plugins, regras de permissão — e tudo isso entraria nas conversas dos
 * agentes. Aqui só existe o login, feito pela tela de Providers.
 */
export function subscriptionHome(kind: 'codex' | 'antigravity', env: NodeJS.ProcessEnv = process.env): string {
  const override = (kind === 'codex' ? env.CODEX_SUB_HOME : env.ANTIGRAVITY_HOME)?.trim()
  if (override) {
    mkdirSync(resolve(override), { recursive: true })
    return resolve(override)
  }
  // ⛔ ANTIGRAVITY NO macOS: O HOME REAL. O `agy` guarda o login no Keychain, e o Keychain mora no HOME:
  // com um HOME falso o macOS não acha o `login.keychain` e oferece "redefinir" — apagaria o Keychain da
  // pessoa. Vale o login do `agy` dela; o isolamento fica no `--sandbox` e no diretório vazio da conversa.
  if (kind === 'antigravity' && process.platform === 'darwin') return homedir()
  const dir = join(dataDir(env), `${kind}-home`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function dataDir(env: NodeJS.ProcessEnv): string {
  const db = env.CONVERSATIONS_DB?.trim()
  return dirname(resolve(db && db !== 'off' ? db : DEFAULT_DB_PATH))
}

const PASSTHROUGH = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME', 'TERM'] as const

/**
 * ⛔ O ambiente mínimo do subprocesso: nunca o `.env` do gateway (chaves de API, `GATEWAY_TOKEN`, o
 * segredo do JWT). Só o que um binário precisa para rodar, mais o que cada cliente pede.
 */
export function subscriptionEnv(extra: Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PASSTHROUGH) if (env[name]) out[name] = env[name] as string
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) out[name] = value
  return out
}
