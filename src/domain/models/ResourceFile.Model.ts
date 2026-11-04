/**
 * Os ARQUIVOS de um recurso (skill, command ou agente): scripts, modelos e dados que o agente usa, numa pasta de
 * verdade — `<dados>/global/skills/<id>/…` no global, `<dados>/projects/<projeto>/skills/<id>/…` no de projeto (e
 * `commands/`, `agents/`). A instrução continua no catálogo; a pasta guarda só os arquivos.
 *
 * ⚖️ O registro do recurso no catálogo leva a LISTA (caminho, sha256, tamanho): é ela que entra no histórico, no
 * reverter e no export. O conteúdo mora num depósito por sha256 que não perde versão — reverter traz o arquivo de antes.
 *
 * ⛔ A pasta é SÓ LEITURA para o agente (o cerco e as ferramentas de arquivo): quem grava é o gateway, pela tela, pela
 * API e pelo importador. Um agente nunca reescreve os próprios scripts.
 */
export interface IResourceFile {
  /** Relativo à pasta do recurso, com `/` (`scripts/balance.mjs`). */
  path: string
  sha256: string
  bytes: number
}

export type TFileOwnerKind = 'skill' | 'command' | 'agent'

/** A pasta de cada tipo, no global e no projeto. */
export const FILE_DIRS: Readonly<Record<TFileOwnerKind, string>> = { skill: 'skills', command: 'commands', agent: 'agents' }

export const RESOURCE_FILE_MAX_BYTES = 1024 * 1024
export const RESOURCE_FILES_MAX_BYTES = 20 * 1024 * 1024
export const RESOURCE_FILES_MAX_COUNT = 200
const PATH_MAX = 300
const DEPTH_MAX = 8
const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/
const SHA256 = /^[a-f0-9]{64}$/

/** O caminho de um arquivo do recurso: relativo, com `/`, sem `.`/`..`, sem pasta escondida do sistema. */
export function filePathIssue(path: unknown): string | undefined {
  if (typeof path !== 'string' || !path) return 'a relative path (scripts/run.mjs)'
  if (path.length > PATH_MAX) return `at most ${PATH_MAX} characters`
  const parts = path.split('/')
  if (parts.length > DEPTH_MAX) return `at most ${DEPTH_MAX} levels`
  for (const part of parts) {
    if (part === '.' || part === '..' || !SEGMENT.test(part)) return 'letters, digits, ".", "_" and "-" per segment, separated by "/" (no "..")'
    if (part === '.git') return '.git is not a resource file'
  }
  return undefined
}

/** A lista em ordem de caminho (a canônica: a mesma lista dá o mesmo hash). */
export function sortFiles(files: readonly IResourceFile[]): IResourceFile[] {
  return [...files].map(({ path, sha256, bytes }) => ({ path, sha256, bytes })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Os problemas da lista: forma de cada arquivo, caminho repetido (ou arquivo e pasta com o mesmo nome) e os tetos. */
export function fileIssues(files: unknown, field = 'files'): Array<{ field: string; message: string }> {
  if (files === undefined) return []
  if (!Array.isArray(files)) return [{ field, message: 'a list of {path, sha256, bytes}' }]
  const issues: Array<{ field: string; message: string }> = []
  if (files.length > RESOURCE_FILES_MAX_COUNT) issues.push({ field, message: `at most ${RESOURCE_FILES_MAX_COUNT} files` })
  const seen = new Set<string>()
  let total = 0
  files.forEach((file: unknown, index) => {
    const at = `${field}[${index}]`
    if (!file || typeof file !== 'object') return issues.push({ field: at, message: 'a {path, sha256, bytes} object' })
    const { path, sha256, bytes } = file as Record<string, unknown>
    const pathIssue = filePathIssue(path)
    if (pathIssue) issues.push({ field: `${at}.path`, message: pathIssue })
    else if (seen.has(path as string)) issues.push({ field: `${at}.path`, message: `repeated: ${path as string}` })
    else seen.add(path as string)
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) issues.push({ field: `${at}.sha256`, message: 'the sha256 of the content (64 hex)' })
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || bytes > RESOURCE_FILE_MAX_BYTES)
      issues.push({ field: `${at}.bytes`, message: `0 to ${RESOURCE_FILE_MAX_BYTES} bytes` })
    else total += bytes
  })
  // `a` e `a/b` juntos: um seria arquivo e pasta ao mesmo tempo.
  for (const path of seen) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join('/')
      if (seen.has(folder)) issues.push({ field, message: `${folder} is both a file and a folder` })
    }
  }
  if (total > RESOURCE_FILES_MAX_BYTES) issues.push({ field, message: `at most ${RESOURCE_FILES_MAX_BYTES} bytes in all` })
  return issues
}

/** A linha que diz ao agente onde estão os arquivos do recurso (o `use_resource`, o `/skill`, o prompt do agente). */
export function filesNote(dir: string, files: readonly IResourceFile[], what: string): string {
  if (!files.length) return ''
  const list = sortFiles(files)
    .slice(0, 50)
    .map((file) => `- ${file.path} (${file.bytes} bytes)`)
  const more = files.length > 50 ? `\n- … e mais ${files.length - 50}` : ''
  return `\n\n## Arquivos ${what}\n\nPasta (só leitura): ${dir}\nRode pelo terminal a partir dela (ex.: \`node ${dir}/${sortFiles(files)[0].path}\`); não grave nela — para trazer ou trocar arquivos, \`attach_resource_files\` (o gateway copia do repositório).\n\n${list.join('\n')}${more}`
}
