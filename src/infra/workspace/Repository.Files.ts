import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { isSecretPath } from '@domain/Permission.Policy'
import { safeGit } from './Git.Safe'
import { IWorkFolder } from './Work.Folder'

/** O maior arquivo que o editor abre (texto). */
export const MAX_EDITOR_BYTES = 1024 * 1024
const MAX_FILES = 20_000

export class RepositoryFileError extends Error {
  constructor(
    readonly kind: 'not_found' | 'invalid' | 'conflict' | 'too_large' | 'forbidden',
    message: string,
    readonly current?: IRepositoryFile,
  ) {
    super(message)
  }
}

export interface IRepositoryFile {
  path: string
  content?: string
  /** O arquivo não é texto (tem byte nulo): o editor não abre. */
  binary?: boolean
  size: number
  /** sha256 do conteúdo: o salvar recusa se o arquivo mudou desde então. */
  hash: string
}

const hashOf = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

/**
 * 🔐 Quem pode mexer em ARQUIVO DE SEGREDO (`.env`, `.credentials/`, chaves) pela tela: só o ADMIN DO PROJETO (`secrets`).
 * Os demais veem o nome na árvore, nunca o valor. ⛔ O agente nunca: o cerco dele é outra trava.
 */
export interface IFileAccess {
  secrets?: boolean
}

/**
 * ⛔ O caminho, conferido: relativo, dentro da pasta (inclusive depois de seguir links), sem `.git` e sem segredo.
 * Devolve o absoluto.
 */
export function safeRepositoryPath(folder: IWorkFolder, path: string, access: IFileAccess = {}): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean || isAbsolute(clean) || clean.split('/').some((part) => part === '..' || part === ''))
    throw new RepositoryFileError('invalid', 'path: a relative path inside the repository')
  if (clean.split('/').includes('.git')) throw new RepositoryFileError('not_found', 'not found')
  if (isSecretPath(clean) && !access.secrets) throw new RepositoryFileError('forbidden', 'secret file: only a project admin opens it')
  const root = realpathSync(folder.dir)
  const full = resolve(root, clean)
  // O arquivo (ou, se ainda não existe, a pasta dele) tem de ficar dentro da raiz depois de seguir os links.
  const anchor = existsSync(full) ? full : dirname(full)
  if (!existsSync(anchor)) throw new RepositoryFileError('not_found', 'folder not found')
  const real = realpathSync(anchor)
  if (real !== root && !real.startsWith(root + sep)) throw new RepositoryFileError('not_found', 'not found')
  return full
}

/** O estado no git de um arquivo não commitado: Modificado, Adicionado, novo (Untracked), Renomeado, apagado (Deleted). */
export type TFileStatus = 'M' | 'A' | 'U' | 'R' | 'D'

/** `git status --porcelain -z`: o estado de cada arquivo não commitado (o nome; o conteúdo de segredo segue protegido). */
export function parseStatus(out: string): Record<string, TFileStatus> {
  const status: Record<string, TFileStatus> = {}
  const entries = out.split('\0')
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    // Renomeado/copiado: o caminho de origem vem na entrada seguinte.
    if (code.includes('R') || code.includes('C')) index += 1
    status[path] = code === '??' ? 'U' : code.includes('R') ? 'R' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : 'M'
  }
  return status
}

/**
 * Os arquivos do repositório, como estão na pasta: os versionados e os novos, e TAMBÉM os ignorados pelo `.gitignore`
 * (`ignored`; uma pasta ignorada inteira vem como `pasta/`, e o que tem dentro se lista quando ela abre — `listFolder`).
 * Os de segredo vêm pelo NOME (`secrets`); o valor só o admin do projeto abre. `.git` nunca.
 */
export async function listRepositoryFiles(
  folder: IWorkFolder,
): Promise<{ files: string[]; ignored: string[]; secrets: string[]; truncated: boolean; status: Record<string, TFileStatus> }> {
  const [out, deletedOut, ignoredOut, porcelain] = await Promise.all([
    safeGit(folder, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 * 1024 * 1024 }),
    safeGit(folder, ['ls-files', '--deleted', '-z'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => undefined),
    safeGit(folder, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ''),
    safeGit(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ''),
  ])
  // Os versionados que sumiram da pasta saem pelo próprio git (`--deleted`). ⚡ Um `existsSync` por arquivo, num repositório
  // grande, eram centenas de milhares de leituras com o servidor parado; ele fica só para quando o git não responde.
  const deleted = deletedOut === undefined ? undefined : new Set(deletedOut.split('\0').filter(Boolean))
  const present = (path: string) => (deleted ? !deleted.has(path) : existsSync(join(folder.dir, path)))
  const all = [...new Set(out.split('\0').filter(Boolean))].filter((path) => !path.split('/').includes('.git') && present(path))
  all.sort((a, b) => a.localeCompare(b))
  const ignored = ignoredOut
    .split('\0')
    .filter(Boolean)
    .filter((path) => !path.split('/').includes('.git'))
    .slice(0, MAX_FILES)
  const files = all.slice(0, MAX_FILES)
  return {
    files,
    ignored,
    secrets: [...files, ...ignored].filter((path) => !path.endsWith('/') && isSecretPath(path)),
    truncated: all.length > MAX_FILES,
    status: parseStatus(porcelain),
  }
}

/** O que tem numa pasta (só um nível): para abrir uma pasta ignorada, que a lista do git traz fechada. */
export function listFolder(folder: IWorkFolder, path: string): { entries: Array<{ path: string; folder: boolean }>; truncated: boolean } {
  const full = path ? safeRepositoryPath(folder, path, { secrets: true }) : realpathSync(folder.dir)
  if (!existsSync(full) || !lstatSync(full).isDirectory()) throw new RepositoryFileError('not_found', 'folder not found')
  const entries = readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git' && !entry.isSymbolicLink())
    .map((entry) => ({ path: path ? `${path}/${entry.name}` : entry.name, folder: entry.isDirectory() }))
  return { entries: entries.slice(0, 5000), truncated: entries.length > 5000 }
}

export function readRepositoryFile(folder: IWorkFolder, path: string, access: IFileAccess = {}): IRepositoryFile {
  const full = safeRepositoryPath(folder, path, access)
  if (!existsSync(full) || !lstatSync(full).isFile()) throw new RepositoryFileError('not_found', 'file not found')
  const data = readFileSync(full)
  const base = { path, size: data.length, hash: hashOf(data) }
  if (data.length > MAX_EDITOR_BYTES) throw new RepositoryFileError('too_large', `file larger than ${MAX_EDITOR_BYTES} bytes`)
  if (data.subarray(0, 8000).includes(0)) return { ...base, binary: true }
  return { ...base, content: data.toString('utf8') }
}

/**
 * Grava o arquivo. ⚖️ `baseHash`: o que a pessoa abriu; se o arquivo mudou desde então (o agente mexeu), recusa e devolve
 * o atual. Arquivo novo: `baseHash` ausente, e a pasta já tem de existir.
 */
export function writeRepositoryFile(folder: IWorkFolder, path: string, content: string, baseHash?: string, access: IFileAccess = {}): IRepositoryFile {
  if (Buffer.byteLength(content) > MAX_EDITOR_BYTES) throw new RepositoryFileError('too_large', `content larger than ${MAX_EDITOR_BYTES} bytes`)
  const full = safeRepositoryPath(folder, path, access)
  if (existsSync(full)) {
    if (!lstatSync(full).isFile()) throw new RepositoryFileError('invalid', 'not a file')
    const current = readRepositoryFile(folder, path, access)
    if (current.hash !== baseHash) throw new RepositoryFileError('conflict', 'the file changed since it was opened', current)
  } else if (baseHash) {
    throw new RepositoryFileError('conflict', 'the file was removed since it was opened')
  }
  writeFileSync(full, content)
  return { path, content, size: Buffer.byteLength(content), hash: hashOf(content) }
}

/** O máximo de itens que uma operação de pasta percorre (copiar, mover, excluir): acima disso, recusa. */
const MAX_TREE_ENTRIES = 20_000

/**
 * ⛔ O que tem dentro de uma pasta antes de mexer nela: nada de segredo (mover `.credentials` para outro nome o tiraria
 * da proteção), nada de `.git` e nada de link. Devolve quantos arquivos há.
 */
function inspectTree(full: string, rel: string, access: IFileAccess): number {
  let count = 0
  const walk = (dir: string, relDir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.name === '.git') throw new RepositoryFileError('invalid', `the folder has a .git (${childRel})`)
      if (isSecretPath(childRel) && !access.secrets) throw new RepositoryFileError('forbidden', `the folder has a secret file (${childRel}): only a project admin moves it`)
      count += 1
      if (count > MAX_TREE_ENTRIES) throw new RepositoryFileError('too_large', `the folder has more than ${MAX_TREE_ENTRIES} items`)
      if (entry.isDirectory()) walk(join(dir, entry.name), childRel)
    }
  }
  walk(full, rel)
  return count
}

function existing(folder: IWorkFolder, path: string, access: IFileAccess): { full: string; isDir: boolean } {
  const full = safeRepositoryPath(folder, path, access)
  if (!existsSync(full)) throw new RepositoryFileError('not_found', 'not found')
  const stat = lstatSync(full)
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new RepositoryFileError('invalid', 'not a file or folder')
  if (stat.isDirectory()) inspectTree(full, path, access)
  return { full, isDir: stat.isDirectory() }
}

/**
 * Move (ou renomeia) um arquivo ou pasta, dentro do repositório. ⛔ Os dois caminhos passam pela conferência de sempre
 * (dentro da pasta, sem `.git`, sem segredo); o destino não pode existir, a pasta dele já tem de existir, e uma pasta não
 * vai para dentro dela mesma.
 */
export function renameRepositoryFile(folder: IWorkFolder, from: string, to: string, access: IFileAccess = {}): { from: string; to: string } {
  const source = existing(folder, from, access)
  const target = safeRepositoryPath(folder, to, access)
  if (existsSync(target)) throw new RepositoryFileError('conflict', 'a file with that name already exists')
  if (source.isDir && (to === from || to.startsWith(`${from}/`))) throw new RepositoryFileError('invalid', 'a folder cannot go inside itself')
  renameSync(source.full, target)
  return { from, to }
}

/** Copia um arquivo ou pasta (com as mesmas travas de mover). */
export function copyRepositoryFile(folder: IWorkFolder, from: string, to: string, access: IFileAccess = {}): { from: string; to: string } {
  const source = existing(folder, from, access)
  const target = safeRepositoryPath(folder, to, access)
  if (existsSync(target)) throw new RepositoryFileError('conflict', 'a file with that name already exists')
  if (source.isDir && to.startsWith(`${from}/`)) throw new RepositoryFileError('invalid', 'a folder cannot go inside itself')
  cpSync(source.full, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  return { from, to }
}

/** Apaga um arquivo ou pasta (o git ainda tem o que estava commitado). Pasta com segredo ou `.git` dentro: recusa. */
export function deleteRepositoryFile(folder: IWorkFolder, path: string, access: IFileAccess = {}): { path: string } {
  const { full } = existing(folder, path, access)
  rmSync(full, { recursive: true, force: false })
  return { path }
}
