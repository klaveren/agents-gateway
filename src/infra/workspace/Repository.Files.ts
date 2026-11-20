import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { isSecretPath } from '@domain/Permission.Policy'
import { safeGit } from './Git.Safe'
import { IWorkFolder } from './Work.Folder'

/** O maior arquivo que o editor abre (texto). */
export const MAX_EDITOR_BYTES = 1024 * 1024
const MAX_FILES = 20_000

export class RepositoryFileError extends Error {
  constructor(
    readonly kind: 'not_found' | 'invalid' | 'conflict' | 'too_large',
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
 * ⛔ O caminho, conferido: relativo, dentro da pasta (inclusive depois de seguir links), sem `.git` e sem segredo.
 * Devolve o absoluto.
 */
export function safeRepositoryPath(folder: IWorkFolder, path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!clean || isAbsolute(clean) || clean.split('/').some((part) => part === '..' || part === ''))
    throw new RepositoryFileError('invalid', 'path: a relative path inside the repository')
  if (clean.split('/').includes('.git')) throw new RepositoryFileError('not_found', 'not found')
  if (isSecretPath(clean)) throw new RepositoryFileError('not_found', 'not found')
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

/** `git status --porcelain -z`: o estado de cada arquivo não commitado (sem segredo). */
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
    if (isSecretPath(path)) continue
    status[path] = code === '??' ? 'U' : code.includes('R') ? 'R' : code.includes('A') ? 'A' : code.includes('D') ? 'D' : 'M'
  }
  return status
}

/** Os arquivos do repositório (versionados e novos, respeitando o `.gitignore`), sem os de segredo, e o que não foi commitado. */
export async function listRepositoryFiles(folder: IWorkFolder): Promise<{ files: string[]; truncated: boolean; status: Record<string, TFileStatus> }> {
  const [out, porcelain] = await Promise.all([
    safeGit(folder, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 * 1024 * 1024 }),
    safeGit(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ''),
  ])
  const all = [...new Set(out.split('\0').filter(Boolean))].filter((path) => !isSecretPath(path) && existsSync(join(folder.dir, path)))
  all.sort((a, b) => a.localeCompare(b))
  return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES, status: parseStatus(porcelain) }
}

export function readRepositoryFile(folder: IWorkFolder, path: string): IRepositoryFile {
  const full = safeRepositoryPath(folder, path)
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
export function writeRepositoryFile(folder: IWorkFolder, path: string, content: string, baseHash?: string): IRepositoryFile {
  if (Buffer.byteLength(content) > MAX_EDITOR_BYTES) throw new RepositoryFileError('too_large', `content larger than ${MAX_EDITOR_BYTES} bytes`)
  const full = safeRepositoryPath(folder, path)
  if (existsSync(full)) {
    if (!lstatSync(full).isFile()) throw new RepositoryFileError('invalid', 'not a file')
    const current = readRepositoryFile(folder, path)
    if (current.hash !== baseHash) throw new RepositoryFileError('conflict', 'the file changed since it was opened', current)
  } else if (baseHash) {
    throw new RepositoryFileError('conflict', 'the file was removed since it was opened')
  }
  writeFileSync(full, content)
  return { path, content, size: Buffer.byteLength(content), hash: hashOf(content) }
}
