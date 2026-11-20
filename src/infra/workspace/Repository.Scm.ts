import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSecretPath } from '@domain/Permission.Policy'
import { safeGit } from './Git.Safe'
import { IFileAccess, MAX_EDITOR_BYTES, RepositoryFileError, TFileStatus } from './Repository.Files'
import { IWorkFolder } from './Work.Folder'

/**
 * 🌿 O CONTROLE DE VERSÃO da conversa, como o do VS Code: branch, à frente/atrás do remoto, o que está preparado (index) e
 * o que não está, o diff de um arquivo, preparar, despreparar e commitar.
 *
 * ⛔ Pelo git endurecido do servidor (`safeGit`): sem hooks, sem filtros, sem transporte (o ↓/↑ é do que o repositório
 * já sabe; ninguém busca nada daqui). Segredo nunca entra: nem na lista, nem no `add`, nem no commit.
 */
export interface IScmEntry {
  path: string
  status: TFileStatus
}

export interface IScmState {
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  staged: IScmEntry[]
  changes: IScmEntry[]
}

const letter = (code: string): TFileStatus => (code === 'A' ? 'A' : code === 'D' ? 'D' : code === 'R' || code === 'C' ? 'R' : 'M')

/** `git status --porcelain=v2 --branch -z`: o cabeçalho da branch e as entradas (index em X, pasta em Y). */
export function parseStatusV2(out: string): IScmState {
  const state: IScmState = { ahead: 0, behind: 0, staged: [], changes: [] }
  const records = out.split('\0')
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    if (record.startsWith('# branch.head ')) {
      const head = record.slice(14)
      if (head !== '(detached)') state.branch = head
    } else if (record.startsWith('# branch.upstream ')) state.upstream = record.slice(18)
    else if (record.startsWith('# branch.ab ')) {
      const [ahead, behind] = record.slice(12).split(' ')
      state.ahead = Math.abs(Number.parseInt(ahead, 10)) || 0
      state.behind = Math.abs(Number.parseInt(behind, 10)) || 0
    } else if (record.startsWith('? ')) {
      const path = record.slice(2)
      state.changes.push({ path, status: 'U' })
    } else if (record.startsWith('1 ') || record.startsWith('2 ') || record.startsWith('u ')) {
      const kind = record[0]
      const fields = record.split(' ')
      const xy = fields[1]
      // 1: 8 campos antes do caminho; 2 (renomeado): 9, e a origem vem no registro seguinte; u (conflito): 10.
      const before = kind === '1' ? 8 : kind === '2' ? 9 : 10
      const path = fields.slice(before).join(' ')
      if (kind === '2') index += 1
      if (kind === 'u') {
        state.changes.push({ path, status: 'M' })
        continue
      }
      if (xy[0] !== '.') state.staged.push({ path, status: letter(xy[0]) })
      if (xy[1] !== '.') state.changes.push({ path, status: letter(xy[1]) })
    }
  }
  return state
}

export async function scmState(folder: IWorkFolder): Promise<IScmState> {
  return parseStatusV2(await safeGit(folder, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }))
}

/** ⛔ O caminho para o git: relativo, sem `..`, sem `.git`, sem segredo. Vai como `:(literal)`: nada de curinga do git. */
function pathspec(path: string, access: IFileAccess = {}): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean || clean.startsWith('/') || clean.split('/').some((part) => part === '..' || part === '' || part === '.git')) {
    throw new RepositoryFileError('invalid', `path: ${path}`)
  }
  if (isSecretPath(clean) && !access.secrets) throw new RepositoryFileError('forbidden', 'secret file: only a project admin opens it')
  return `:(literal)${clean}`
}

/** O conteúdo de um blob (`HEAD:caminho` ou `:caminho`, o index); vazio se não existe lá. */
async function blob(folder: IWorkFolder, spec: string): Promise<string> {
  try {
    return await safeGit(folder, ['cat-file', 'blob', spec], { maxBuffer: MAX_EDITOR_BYTES * 2 })
  } catch {
    return ''
  }
}

/**
 * O diff de um arquivo, como o VS Code: o preparado compara o último commit com o index; o não preparado, o index (ou o
 * último commit) com a pasta.
 */
export async function scmDiff(
  folder: IWorkFolder,
  path: string,
  staged: boolean,
  commit?: string,
  access: IFileAccess = {},
): Promise<{ path: string; original: string; modified: string }> {
  pathspec(path, access)
  // De um commit da Timeline: o arquivo antes dele (o pai) e depois dele.
  if (commit) {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new RepositoryFileError('invalid', 'commit: a commit sha')
    return { path, original: await blob(folder, `${commit}^:${path}`), modified: await blob(folder, `${commit}:${path}`) }
  }
  if (staged) return { path, original: await blob(folder, `HEAD:${path}`), modified: await blob(folder, `:${path}`) }
  const full = join(folder.dir, path)
  let modified = ''
  if (existsSync(full) && lstatSync(full).isFile()) {
    const data = readFileSync(full)
    if (data.length > MAX_EDITOR_BYTES) throw new RepositoryFileError('too_large', `file larger than ${MAX_EDITOR_BYTES} bytes`)
    modified = data.toString('utf8')
  }
  const index = await blob(folder, `:${path}`)
  return { path, original: index || (await blob(folder, `HEAD:${path}`)), modified }
}

export async function scmStage(folder: IWorkFolder, paths: readonly string[]): Promise<void> {
  if (!paths.length) return
  await safeGit(folder, ['add', '-A', '--', ...paths.map((path) => pathspec(path))])
}

export async function scmUnstage(folder: IWorkFolder, paths: readonly string[]): Promise<void> {
  if (!paths.length) return
  const specs = paths.map((path) => pathspec(path))
  const hasHead = await safeGit(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
    () => true,
    () => false,
  )
  await safeGit(folder, hasHead ? ['reset', '--quiet', 'HEAD', '--', ...specs] : ['rm', '--cached', '--quiet', '-r', '--', ...specs])
}

/**
 * Commita o preparado; sem nada preparado, prepara antes TODAS as alterações (menos segredo), como o VS Code.
 * ⛔ `--no-verify` e `core.hooksPath=/dev/null` (já nas travas): hook nenhum roda; sem assinatura (o programa dela é da config).
 */
export async function scmCommit(folder: IWorkFolder, message: string, author: { name: string; email: string }): Promise<{ commit: string }> {
  const text = message.trim()
  if (!text) throw new RepositoryFileError('invalid', 'message: write a commit message')
  // ⛔ A lista esconde segredo; o index, não: o agente pode ter preparado um `.env` sozinho. Confere no git, cru.
  const index = (await safeGit(folder, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean)
  const secret = index.find((path) => isSecretPath(path))
  if (secret) throw new RepositoryFileError('invalid', `a secret file is staged (${secret}): unstage it before committing`)
  const state = await scmState(folder)
  if (!state.staged.length) {
    // ⛔ Segredo nunca entra no commit automático: ele aparece na lista, mas fica de fora.
    const toStage = state.changes.filter((entry) => !isSecretPath(entry.path)).map((entry) => entry.path)
    if (!toStage.length) throw new RepositoryFileError('invalid', 'nothing to commit')
    await scmStage(folder, toStage)
  }
  await safeGit(folder, ['-c', 'commit.gpgSign=false', 'commit', '--no-verify', '--quiet', '-m', text], { author })
  return { commit: (await safeGit(folder, ['rev-parse', 'HEAD'])).trim() }
}

/** Quem mudou uma linha por último (o "blame" da barra de status). `uncommitted`: a linha ainda não foi commitada. */
export interface IScmBlame {
  commit?: string
  author?: string
  time?: number
  summary?: string
  uncommitted?: boolean
}

export function parseBlame(out: string): IScmBlame | undefined {
  const lines = out.split('\n')
  const commit = lines[0]?.split(' ')[0]
  if (!commit || !/^[0-9a-f]{40}$/.test(commit)) return undefined
  if (/^0+$/.test(commit)) return { uncommitted: true }
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1)
  return { commit, author: field('author'), time: Number(field('author-time')) || undefined, summary: field('summary') }
}

export async function scmBlame(folder: IWorkFolder, path: string, line: number, access: IFileAccess = {}): Promise<IScmBlame | undefined> {
  const spec = pathspec(path, access).replace(/^:\(literal\)/, '')
  if (!Number.isInteger(line) || line < 1) throw new RepositoryFileError('invalid', 'line: a positive integer')
  try {
    return parseBlame(await safeGit(folder, ['blame', '--porcelain', '-L', `${line},${line}`, '--', spec], { maxBuffer: 1024 * 1024 }))
  } catch {
    return undefined
  }
}

/** Um commit da Timeline do arquivo. */
export interface IScmCommit {
  sha: string
  author: string
  time: number
  subject: string
}

/** A TIMELINE: os commits que mexeram no arquivo (seguindo renomeação), do mais novo ao mais velho. */
export async function scmHistory(folder: IWorkFolder, path: string, limit = 50, access: IFileAccess = {}): Promise<IScmCommit[]> {
  const spec = pathspec(path, access).replace(/^:\(literal\)/, '')
  let out: string
  try {
    out = await safeGit(folder, ['log', '--follow', `-n${Math.min(200, Math.max(1, limit))}`, '--format=%H%x1f%an%x1f%at%x1f%s%x1e', '--', spec], { maxBuffer: 4 * 1024 * 1024 })
  } catch {
    return []
  }
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, author, time, subject] = record.split('\x1f')
      return { sha, author, time: Number(time) || 0, subject: subject ?? '' }
    })
}
