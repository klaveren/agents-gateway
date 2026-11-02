/**
 * Os ARQUIVOS de um recurso (skill, command ou agente) na tela: a lista que o servidor grava (o conteúdo mora num
 * depósito por sha256) e as regras de caminho, as mesmas do servidor (`ResourceFile.Model`).
 */
export interface IResourceFile {
  path: string
  sha256: string
  bytes: number
}

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/

/** O problema do caminho na lista (vazio = pode), sem contar o próprio índice. */
export function fileIssue(path: string, files: readonly IResourceFile[], index?: number): string | undefined {
  const parts = path.split('/')
  if (!path) return 'Dê um caminho (scripts/run.sh).'
  if (path.length > 300 || parts.length > 8) return 'Caminho longo demais (até 300 caracteres e 8 níveis).'
  if (parts.some((part) => part === '.' || part === '..' || part === '.git' || !SEGMENT.test(part))) return 'Use letras, dígitos, ".", "_" e "-", separados por "/" (sem "..").'
  const others = files.filter((_, at) => at !== index).map((file) => file.path)
  if (others.includes(path)) return `Já existe: ${path}.`
  if (others.some((other) => other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) return 'Um arquivo não pode ser também pasta.'
  return undefined
}

/** O texto em bytes UTF-8. */
export function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Bytes em base64 (em pedaços: `String.fromCharCode(...)` com 1 MB estoura a pilha). */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}
