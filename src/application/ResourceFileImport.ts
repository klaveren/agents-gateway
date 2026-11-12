import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { filePathIssue, IResourceFile, RESOURCE_FILE_MAX_BYTES, RESOURCE_FILES_MAX_BYTES, RESOURCE_FILES_MAX_COUNT } from '@domain/models/ResourceFile.Model'
import { IResourceFilesPort } from '@domain/ports/ResourceFiles.Port'

/**
 * ⚖️ OS ARQUIVOS DE UM RECURSO TRAZIDOS DO REPOSITÓRIO (`attach_resource_files`): o agente aponta a pasta (a `scripts/` de
 * uma skill do formato antigo, `.agents/skills/<id>/scripts`) e o GATEWAY copia, no servidor — o agente nunca lê nem
 * escreve o conteúdo, e a pasta do recurso segue só leitura para ele.
 *
 * ⛔ FICA DE FORA, com o motivo: o que não é do recurso (`node_modules`, `.git`), o que costuma ter segredo (`.env*`,
 * `.credentials`, chave privada), binário, grande demais, e todo arquivo em que a máscara acha um segredo — segredo é
 * variável secreta (guia Variáveis), nunca arquivo.
 */
export interface IRepositoryFileImport {
  /** Os arquivos que entraram, com o caminho dentro do recurso. */
  added: IResourceFile[]
  /** Os que ficaram de fora, com o motivo. */
  skipped: Array<{ path: string; reason: string }>
}

/** Nomes que nunca entram (pasta ou arquivo). */
const NEVER = new Set(['node_modules', '.git', '.credentials', '.DS_Store', '__pycache__', '.venv', 'venv'])
const SECRET_NAME = /^\.env(\..*)?$|\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|ed25519|ecdsa)$|credentials?\.json$|^secrets?\./i
/** Os de exemplo (`.env.example`) entram: não têm valor — mas só se a máscara não achar nada neles. */
const EXAMPLE = /\.(example|sample|template)$/i

/**
 * Lê `from` (um arquivo ou uma pasta, dentro de `root`) e põe cada arquivo no depósito, com o caminho `to` + o relativo.
 * Lança com o motivo quando `from` sai de `root` ou não existe.
 */
export function importRepositoryFiles(
  root: string,
  from: string,
  to: string,
  deps: { files: Pick<IResourceFilesPort, 'put'>; secretsIn?: (text: string) => string[] },
): IRepositoryFileImport {
  const base = realpathSync(root)
  let source: string
  try {
    source = realpathSync(join(base, from))
  } catch {
    throw new Error(`not found: ${from}`)
  }
  if (source !== base && !source.startsWith(`${base}${sep}`)) throw new Error(`outside the project folder: ${from}`)
  const prefix = to.replace(/^\/+|\/+$/g, '')
  const added: IResourceFile[] = []
  const skipped: Array<{ path: string; reason: string }> = []
  let total = 0

  const visit = (absolute: string, inside: string) => {
    const name = inside.split('/').pop() ?? ''
    if (NEVER.has(name)) return void skipped.push({ path: inside, reason: 'not part of a resource' })
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink()) return void skipped.push({ path: inside, reason: 'symbolic link' })
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry), inside ? `${inside}/${entry}` : entry)
      return
    }
    if (!stat.isFile()) return
    const path = prefix ? `${prefix}/${inside}` : inside
    if (SECRET_NAME.test(name) && !EXAMPLE.test(name)) return void skipped.push({ path, reason: 'may hold a secret: use a secret variable (Variáveis)' })
    const issue = filePathIssue(path)
    if (issue) return void skipped.push({ path, reason: issue })
    if (stat.size > RESOURCE_FILE_MAX_BYTES) return void skipped.push({ path, reason: `larger than ${RESOURCE_FILE_MAX_BYTES} bytes` })
    // ⛔ O agente escreve nesta pasta: entre o `lstat` e a leitura o arquivo pode virar link para fora (ou crescer).
    const content = readUnlinked(absolute, RESOURCE_FILE_MAX_BYTES)
    if (!content) return void skipped.push({ path, reason: 'changed while it was being read' })
    if (content.subarray(0, 8192).includes(0)) return void skipped.push({ path, reason: 'binary: only text files' })
    const secrets = deps.secretsIn?.(content.toString('utf8')) ?? []
    if (secrets.length) return void skipped.push({ path, reason: `has a secret (${[...new Set(secrets)].join(', ')}): read it from a secret variable` })
    if (added.length >= RESOURCE_FILES_MAX_COUNT) return void skipped.push({ path, reason: `more than ${RESOURCE_FILES_MAX_COUNT} files` })
    if (total + content.length > RESOURCE_FILES_MAX_BYTES) return void skipped.push({ path, reason: `over ${RESOURCE_FILES_MAX_BYTES} bytes in all` })
    total += content.length
    added.push({ path, ...deps.files.put(content) })
  }

  // Um arquivo só entra pelo nome dele; uma pasta, pelo que está dentro dela.
  visit(source, lstatSync(source).isFile() ? basename(source) : '')
  return { added, skipped }
}

/** A lista nova: a de agora, com os que entraram por cima (mesmo caminho troca) e sem os `remove`. */
export function mergeFiles(current: readonly IResourceFile[], added: readonly IResourceFile[], remove: readonly string[] = []): IResourceFile[] {
  const byPath = new Map(current.map((file) => [file.path, file]))
  for (const path of remove) for (const key of [...byPath.keys()]) if (key === path || key.startsWith(`${path.replace(/\/+$/, '')}/`)) byPath.delete(key)
  for (const file of added) byPath.set(file.path, file)
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Lê o arquivo comum sem seguir link no último nome, com o tamanho conferido no descritor já aberto. */
function readUnlinked(path: string, maxBytes: number): Buffer | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= maxBytes ? readFileSync(fd) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
