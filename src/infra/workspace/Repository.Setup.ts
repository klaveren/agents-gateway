import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { classifyAddress } from '@domain/Address.Policy'
import { safeGit, SAFE_GIT_CONFIG } from './Git.Safe'
import { REPOSITORIES_DIR, REPOSITORY_NAME, WORKTREE_NAME, worktreeFolders } from './Work.Folder'

const run = promisify(execFile)

export type TRepositorySetupCode = 'invalid' | 'exists' | 'not_found' | 'busy' | 'failed'

/** O que deu errado ao criar, clonar ou remover; `field` é o campo do pedido, quando o erro é dele. */
export class RepositorySetupError extends Error {
  constructor(
    readonly code: TRepositorySetupCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'RepositorySetupError'
  }
}

export interface ICloneInput {
  /** A URL `https://` do repositório. */
  source: string
  /** O nome da pasta; ausente = o do fim da URL. */
  name?: string
  branch?: string
  /** As variáveis da Conta do projeto (o helper de credencial do git e o token dele). */
  env?: Record<string, string>
  /** O servidor (`host[:porta]`) da Conta "Git HTTPS": o único que pode ficar na rede privada. */
  privateHost?: string
}

export interface IInitInput {
  name: string
  branch?: string
  /** Quem assina o commit inicial. */
  author?: string
}

/** O git e o DNS, trocáveis nos testes. */
export interface IRepositorySetupRuntime {
  git?: (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<void>
  resolve?: (host: string) => Promise<string[]>
  timeoutMs?: number
}

const CLONE_TIMEOUT_MS = 15 * 60_000
/** A pasta que a convenção dos agentes usa para as worktrees (`repositories/_worktrees/<nome>`). */
const RESERVED_NAMES = new Set(['_worktrees'])
const PASSTHROUGH_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'GIT_SSL_CAINFO']

/** As pastas em preparo (clone ou criação em curso), pelo caminho. */
const inProgress = new Set<string>()

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function repositoriesRoot(projectDir: string): string {
  return join(real(projectDir), REPOSITORIES_DIR)
}

/** Os repositórios em preparo neste projeto (o clone ainda corre): a lista os mostra e ninguém os remove. */
export function repositoriesInSetup(projectDir: string): string[] {
  const root = repositoriesRoot(projectDir) + sep
  return [...inProgress].filter((dir) => dir.startsWith(root)).map((dir) => dir.slice(root.length))
}

/**
 * ⛔ A URL de onde se clona: só `https://`, sem credencial nela (iria para o `.git/config`, o log e a tela) e sem `?`
 * nem `#`. A credencial é a de uma Conta do projeto, que o git recebe pelo helper.
 */
export function cloneSource(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new RepositorySetupError('invalid', 'url: uma URL https (ex.: https://github.com/empresa/app.git)', 'url')
  }
  if (parsed.protocol !== 'https:') throw new RepositorySetupError('invalid', 'url: só https (SSH ainda não entra aqui)', 'url')
  if (parsed.username || parsed.password) throw new RepositorySetupError('invalid', 'url: sem usuário ou token na URL — escolha uma Conta do projeto', 'url')
  if (parsed.search || parsed.hash) throw new RepositorySetupError('invalid', 'url: sem ? nem #', 'url')
  if (!parsed.hostname || parsed.pathname.replace(/\/+$/, '') === '') throw new RepositorySetupError('invalid', 'url: falta o caminho do repositório', 'url')
  return parsed
}

/** O nome da pasta tirado do fim da URL (`…/app.git` → `app`). */
export function repositoryNameFrom(source: URL): string | undefined {
  const last = source.pathname.split('/').filter(Boolean).pop()
  if (!last) return undefined
  try {
    return decodeURIComponent(last).replace(/\.git$/i, '') || undefined
  } catch {
    return undefined
  }
}

/** ⛔ O nome de um repositório NOVO: uma pasta só, sem ponto na frente (`.git`, `..`) e fora das reservadas. */
function newRepositoryName(name: string): string {
  if (!REPOSITORY_NAME.test(name) || name.startsWith('.') || name.startsWith('-') || RESERVED_NAMES.has(name))
    throw new RepositorySetupError('invalid', 'name: só o nome da pasta — letras, números, ponto, traço e sublinhado, sem começar por ponto', 'name')
  return name
}

function branchName(branch: string): string {
  if (!WORKTREE_NAME.test(branch) || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/'))
    throw new RepositorySetupError('invalid', 'branch: o nome de uma branch, sem espaço', 'branch')
  return branch
}

/** A pasta do repositório novo, que ainda não pode existir. */
function newTarget(projectDir: string, name: string): string {
  const root = repositoriesRoot(projectDir)
  const target = join(root, name)
  if (inProgress.has(target)) throw new RepositorySetupError('busy', `name: ${name} já está sendo preparado`, 'name')
  if (existsSync(target)) throw new RepositorySetupError('exists', `name: já existe ${REPOSITORIES_DIR}/${name} neste projeto`, 'name')
  mkdirSync(root, { recursive: true })
  // ⛔ A pasta `repositories` é do projeto: um link que leva para fora não recebe repositório.
  if (!inside(real(projectDir), real(root))) throw new RepositorySetupError('invalid', `${REPOSITORIES_DIR}/ leva para fora da pasta do projeto`)
  return target
}

/** O ambiente do git do gateway ao criar um repositório: sem config do sistema ou do usuário, sem pergunta de senha. */
function setupEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    LC_ALL: 'C',
  }
  for (const key of PASSTHROUGH_ENV) if (process.env[key]) env[key] = process.env[key]
  return { ...env, ...extra }
}

async function runGit(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  await run('git', args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env })
}

/**
 * ⛔ PARA ONDE O CLONE VAI: o gateway clona FORA do cerco, com a rede dele. Loopback, link-local (os metadados da
 * nuvem) e endereço não especificado, nunca; rede privada, só o servidor de uma Conta "Git HTTPS" escolhida. Os
 * endereços conferidos são os que o git usa (`http.curloptResolve`): o nome não muda de destino entre a conferência e
 * a conexão.
 */
async function guardedAddresses(source: URL, privateHost: string | undefined, resolveHost: (host: string) => Promise<string[]>): Promise<string[]> {
  const host = source.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const literal = isIP(host) !== 0
  const addresses = literal ? [host] : await resolveHost(host).catch(() => [] as string[])
  if (!addresses.length) throw new RepositorySetupError('invalid', `url: o servidor ${host} não foi encontrado`, 'url')
  for (const address of addresses) {
    const kind = classifyAddress(address)
    if (kind === 'public') continue
    if (kind === 'private' && privateHost && privateHost.toLowerCase() === source.host.toLowerCase()) continue
    throw new RepositorySetupError(
      'invalid',
      kind === 'private' ? `url: ${host} fica na rede privada — cadastre uma Conta "Git HTTPS" desse servidor e escolha-a` : `url: ${host} é sempre negado`,
      'url',
    )
  }
  return literal ? [] : addresses
}

/** O que o git disse, sem nenhum valor das variáveis da Conta. */
function gitMessage(error: unknown, secrets: readonly string[]): string {
  const failure = error as { stderr?: unknown; message?: unknown }
  let text = typeof failure?.stderr === 'string' && failure.stderr.trim() ? failure.stderr : String(failure?.message ?? error)
  for (const secret of secrets) if (secret.length >= 6) text = text.split(secret).join('***')
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Cloning into/i.test(line))
  return lines.slice(-3).join(' ').slice(0, 500)
}

function cloneFailure(error: unknown, secrets: readonly string[], timeoutMs: number): RepositorySetupError {
  if ((error as { killed?: boolean })?.killed) return new RepositorySetupError('failed', `o clone passou de ${Math.round(timeoutMs / 60_000)} min e foi interrompido`)
  const message = gitMessage(error, secrets)
  if (/Remote branch .* not found/i.test(message)) return new RepositorySetupError('invalid', 'branch: essa branch não existe no repositório', 'branch')
  const credential = /could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[13]|Repository not found|not found/i.test(message)
  return new RepositorySetupError('failed', credential ? `o servidor não liberou o repositório: confira a URL e escolha uma Conta do projeto que o alcance (${message})` : message)
}

/**
 * CLONAR um repositório para `<projeto>/repositories/<nome>`, pelo gateway (fora do cerco, sem agente).
 *
 * ⛔ Só `https`, sem submódulos, sem redirecionamento (o destino conferido é o que responde), sem config do sistema
 * ou do usuário e sem hooks. A credencial vem das variáveis da Conta (`ProjectAccountsService.gitEnv`): nada dela fica
 * no `.git/config`. Se o clone falha, a pasta pela metade sai.
 */
export async function cloneRepository(projectDir: string, input: ICloneInput, runtime: IRepositorySetupRuntime = {}): Promise<string> {
  const source = cloneSource(input.source)
  const fromUrl = input.name?.trim() || repositoryNameFrom(source)
  if (!fromUrl) throw new RepositorySetupError('invalid', 'name: informe o nome da pasta', 'name')
  const name = newRepositoryName(fromUrl)
  const branch = input.branch?.trim() ? branchName(input.branch.trim()) : undefined
  const target = newTarget(projectDir, name)
  const timeoutMs = runtime.timeoutMs ?? CLONE_TIMEOUT_MS

  inProgress.add(target)
  try {
    const addresses = await guardedAddresses(source, input.privateHost, runtime.resolve ?? (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address)))
    const pin = addresses.length ? ['-c', `http.curloptResolve=${source.hostname}:${source.port || '443'}:${addresses.join(',')}`] : []
    const args = [
      ...SAFE_GIT_CONFIG,
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'http.followRedirects=false',
      ...pin,
      'clone',
      '--no-recurse-submodules',
      ...(branch ? ['--branch', branch] : []),
      '--',
      source.href,
      target,
    ]
    try {
      await (runtime.git ?? runGit)(args, setupEnv(input.env), timeoutMs)
    } catch (error: unknown) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw cloneFailure(error, Object.values(input.env ?? {}), timeoutMs)
    }
    if (!existsSync(join(target, '.git'))) throw new RepositorySetupError('failed', 'o clone terminou sem criar o repositório')
    return name
  } finally {
    inProgress.delete(target)
  }
}

/**
 * CRIAR um repositório LOCAL (sem remoto) em `<projeto>/repositories/<nome>`: `git init` e um commit inicial vazio — sem
 * ele não há de onde tirar worktree.
 */
export async function initRepository(projectDir: string, input: IInitInput, runtime: IRepositorySetupRuntime = {}): Promise<string> {
  const name = newRepositoryName(input.name.trim())
  const branch = branchName(input.branch?.trim() || 'main')
  const target = newTarget(projectDir, name)
  const author = (input.author ?? '').replace(/[<>\n\r]/g, '').trim() || 'Agents Gateway'

  inProgress.add(target)
  try {
    try {
      await (runtime.git ?? runGit)([...SAFE_GIT_CONFIG, 'init', '-q', '-b', branch, '--', target], setupEnv(), 30_000)
      await safeGit({ dir: target, gitCommonDir: join(target, '.git') }, [
        '-c',
        `user.name=${author}`,
        '-c',
        'user.email=gateway@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Início do repositório',
      ])
    } catch (error: unknown) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      const message = gitMessage(error, [])
      if (/invalid (initial )?branch name|not a valid branch name/i.test(message)) throw new RepositorySetupError('invalid', 'branch: o nome de uma branch, sem espaço', 'branch')
      throw new RepositorySetupError('failed', message)
    }
    return name
  } finally {
    inProgress.delete(target)
  }
}

/**
 * REMOVER um repositório do projeto: a pasta dele e as worktrees dele que ficam em `repositories/`. Devolve as worktrees
 * que ficaram no disco (as de fora de `repositories/`), para a tela avisar.
 *
 * ⛔ Só uma pasta de verdade (não link) com o `.git` dela; a worktree só sai se o `.git` dela aponta de volta para este
 * repositório (`worktreeFolders`) e se não guarda a worktree de outro repositório dentro.
 */
export async function removeRepository(projectDir: string, name: string): Promise<{ kept: string[] }> {
  if (!REPOSITORY_NAME.test(name) || name === '.' || name === '..') throw new RepositorySetupError('invalid', 'name: só o nome da pasta, sem barra', 'name')
  const project = real(projectDir)
  const root = repositoriesRoot(projectDir)
  const dir = join(root, name)
  if (inProgress.has(dir)) throw new RepositorySetupError('busy', `${name} ainda está sendo preparado`)
  const isRepository = (path: string): boolean => {
    try {
      return lstatSync(path).isDirectory() && lstatSync(join(path, '.git')).isDirectory()
    } catch {
      return false
    }
  }
  if (!inside(project, real(root)) || !isRepository(dir)) throw new RepositorySetupError('not_found', `Repositório não encontrado: ${name}`)

  // As worktrees dos OUTROS repositórios: a pasta que guarda uma delas fica.
  const foreign = readdirSync(root)
    .filter((entry) => entry !== name && REPOSITORY_NAME.test(entry))
    .flatMap((entry) => worktreeFolders(projectDir, entry))
  const kept: string[] = []
  const doomed: string[] = []
  for (const worktree of worktreeFolders(projectDir, name)) {
    if (inside(dir, worktree)) continue
    const safe = worktree !== root && inside(root, worktree) && !foreign.some((other) => inside(worktree, other))
    if (safe) doomed.push(worktree)
    else kept.push(relative(project, worktree).split(sep).join('/'))
  }
  for (const worktree of doomed) await rm(worktree, { recursive: true, force: true, maxRetries: 2 })
  await rm(dir, { recursive: true, force: true, maxRetries: 2 })
  return { kept }
}
