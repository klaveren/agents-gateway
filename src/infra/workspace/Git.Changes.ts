import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { deniedPath } from '@infra/tools/File.Tools'
import { join } from 'node:path'

const run = promisify(execFile)

export type TChangeScope = 'conversation' | 'uncommitted' | 'branch'
export const CHANGE_SCOPES: readonly TChangeScope[] = ['conversation', 'uncommitted', 'branch']

export interface IChangedFile {
  path: string
  oldPath?: string
  status: 'M' | 'A' | 'D' | 'R' | 'U'
  additions: number
  deletions: number
  binary: boolean
  /** Segredo (`.env`, chave): aparece na lista, o conteúdo nunca. */
  protected?: boolean
}

export interface IChangeCommit {
  sha: string
  subject: string
  author: string
  at: string
}

export interface IChanges {
  scope: TChangeScope
  /** De onde o recorte parte (o commit), e o commit pedido quando é um só. */
  from?: string
  commit?: string
  files: IChangedFile[]
  commits: IChangeCommit[]
  truncated: boolean
}

export const CHANGE_LIMITS = { files: 300, diffBytes: 200 * 1024 } as const

/**
 * ⛔ O GIT SÓ DE LEITURA, sem nada do repositório que execute programa: sem diff externo, sem textconv, sem fsmonitor,
 * sem pager, sem a config do sistema, sem pedir senha. A config do repositório é de quem o prepara (a esteira), mas uma
 * entrada maliciosa nela não pode rodar código no gateway.
 */
async function git(dir: string, args: readonly string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await run(
    'git',
    ['-C', dir, '-c', 'core.fsmonitor=', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.noprefix=false', ...args],
    {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', HOME: '/nonexistent' },
    },
  )
  return stdout
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M']

async function revParse(dir: string, ref: string): Promise<string | undefined> {
  return (await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim() || undefined
}

/** A base do branch: `origin/HEAD`, senão o primeiro de `main`, `master`, `automation` (local ou do origin). */
async function branchBase(dir: string): Promise<string | undefined> {
  for (const ref of ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master', 'origin/automation', 'automation']) {
    const sha = await revParse(dir, ref)
    if (!sha) continue
    const base = (await git(dir, ['merge-base', 'HEAD', sha]).catch(() => '')).trim()
    if (base) return base
  }
  return undefined
}

/** De onde o recorte parte. `undefined` = do início (repositório sem commit). */
async function rangeStart(dir: string, scope: TChangeScope, startCommit?: string): Promise<string | undefined> {
  if (scope === 'uncommitted') return revParse(dir, 'HEAD')
  if (scope === 'conversation' && startCommit && (await revParse(dir, startCommit))) return startCommit
  return (await branchBase(dir)) ?? revParse(dir, 'HEAD')
}

/** Os arquivos de `git diff --name-status -z` e `--numstat -z` juntos. */
function parseFiles(nameStatus: string, numstat: string): IChangedFile[] {
  const files: IChangedFile[] = []
  const tokens = nameStatus.split('\0').filter((token) => token !== '')
  for (let index = 0; index < tokens.length;) {
    const code = tokens[index++]
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[index++]
      const path = tokens[index++]
      files.push({ path, oldPath, status: kind === 'R' ? 'R' : 'A', additions: 0, deletions: 0, binary: false })
    } else {
      const path = tokens[index++]
      files.push({ path, status: (['M', 'A', 'D'].includes(kind) ? kind : 'U') as IChangedFile['status'], additions: 0, deletions: 0, binary: false })
    }
  }
  // numstat -z: "<add>\t<del>\t<path>\0" ou, renomeado, "<add>\t<del>\t\0<old>\0<new>\0".
  const parts = numstat.split('\0')
  for (let index = 0; index < parts.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[index])
    if (!match) continue
    const path = match[3] === '' ? parts[(index += 2)] : match[3]
    const file = files.find((item) => item.path === path)
    if (!file) continue
    file.binary = match[1] === '-'
    file.additions = file.binary ? 0 : Number(match[1])
    file.deletions = file.binary ? 0 : Number(match[2])
  }
  return files
}

function isProtected(dir: string, path: string): boolean {
  return !!deniedPath(join(dir, path), dir) && !/(^|\/)\.git(\/|$)/.test(path)
}

/**
 * O que mudou na pasta da conversa, no recorte pedido: os arquivos (estado, linhas, binário) e os commits. Com
 * `commit`, só o que aquele commit mudou.
 */
export async function changesOf(dir: string, scope: TChangeScope, options: { startCommit?: string; commit?: string } = {}): Promise<IChanges> {
  if (options.commit) {
    const sha = await revParse(dir, options.commit)
    if (!sha) throw new Error(`commit: ${options.commit} não existe aqui`)
    const range = [`${sha}^!`]
    const files = parseFiles(await git(dir, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...range]), await git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range]))
    return finish(dir, { scope, commit: sha, files, commits: await commitsOf(dir, `${sha}^!`), truncated: false })
  }
  const from = await rangeStart(dir, scope, options.startCommit)
  // ⚖️ Contra a ÁRVORE DE TRABALHO (sem `..HEAD`): entra o commitado no recorte e o que ainda não foi.
  const base = from ? [from] : []
  const files = parseFiles(await git(dir, ['diff', ...DIFF_FLAGS, '--name-status', '-z', ...base]), await git(dir, ['diff', ...DIFF_FLAGS, '--numstat', '-z', ...base]))
  for (const path of (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
    if (!files.some((file) => file.path === path)) files.push({ path, status: 'A', additions: await lineCount(dir, path), deletions: 0, binary: false })
  }
  const commits = scope === 'uncommitted' || !from ? [] : await commitsOf(dir, `${from}..HEAD`)
  return finish(dir, { scope, ...(from ? { from } : {}), files, commits, truncated: false })
}

function finish(dir: string, changes: IChanges): IChanges {
  const sorted = changes.files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => (isProtected(dir, file.path) ? { ...file, protected: true } : file))
  return { ...changes, files: sorted.slice(0, CHANGE_LIMITS.files), truncated: sorted.length > CHANGE_LIMITS.files }
}

async function commitsOf(dir: string, range: string): Promise<IChangeCommit[]> {
  const out = await git(dir, ['log', '--no-color', '--format=%H%x1f%s%x1f%an%x1f%aI%x1e', '-n', '200', range]).catch(() => '')
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, subject, author, at] = record.split('\x1f')
      return { sha, subject, author, at }
    })
}

async function lineCount(dir: string, path: string): Promise<number> {
  const numstat = await git(dir, ['diff', ...DIFF_FLAGS, '--no-index', '--numstat', '--', '/dev/null', path]).catch((error: { stdout?: string }) => error.stdout ?? '')
  const match = /^(-|\d+)\t/.exec(numstat)
  return match && match[1] !== '-' ? Number(match[1]) : 0
}

/**
 * O diff unificado de UM arquivo do recorte. ⛔ Só de arquivo que está na lista (quem chama confere), nunca de segredo,
 * e com teto de tamanho.
 */
export async function fileDiff(dir: string, changes: IChanges, path: string): Promise<{ diff: string; truncated: boolean; protected?: boolean; binary?: boolean }> {
  const file = changes.files.find((item) => item.path === path)
  if (!file) throw new Error(`file: ${path} não está entre as alterações deste recorte`)
  if (file.protected) return { diff: '', truncated: false, protected: true }
  if (file.binary) return { diff: '', truncated: false, binary: true }
  const paths = ['--', ...(file.oldPath ? [file.oldPath] : []), file.path]
  let diff: string
  if (changes.commit) diff = await git(dir, ['diff', ...DIFF_FLAGS, '-U3', `${changes.commit}^!`, ...paths], CHANGE_LIMITS.diffBytes * 4)
  else {
    const tracked = await git(dir, ['ls-files', '--error-unmatch', '--', file.path]).then(
      () => true,
      () => false,
    )
    diff = tracked
      ? await git(dir, ['diff', ...DIFF_FLAGS, '-U3', ...(changes.from ? [changes.from] : []), ...paths], CHANGE_LIMITS.diffBytes * 4)
      : await git(dir, ['diff', ...DIFF_FLAGS, '-U3', '--no-index', '--', '/dev/null', file.path], CHANGE_LIMITS.diffBytes * 4).catch(
          (error: { stdout?: string }) => error.stdout ?? '',
        )
  }
  const truncated = Buffer.byteLength(diff) > CHANGE_LIMITS.diffBytes
  return { diff: truncated ? Buffer.from(diff).subarray(0, CHANGE_LIMITS.diffBytes).toString('utf8') : diff, truncated }
}

/** O HEAD de agora (o commit de partida da conversa). */
export async function headOf(dir: string): Promise<string | undefined> {
  return revParse(dir, 'HEAD')
}
