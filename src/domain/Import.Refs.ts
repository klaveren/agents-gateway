import { posix } from 'node:path'
import { CANDIDATE_ID_MAX, TInventoryKind } from './models/ImportInventory.Model'

/**
 * As CITAÇÕES de um arquivo importado: os caminhos que o texto cita (`.agents/specs/x.md`, `specs/x.md`, `{file:…}`,
 * link de markdown, lista de dependências em YAML). Puro: quem diz se o arquivo existe é a árvore (`resolve`).
 */

const EXTENSIONS = 'md|mdx|mdc|markdown|ya?ml|jsonc?|toml|txt'
/** Um caminho relativo com extensão de texto. O lado esquerdo não pode ser parte de URL nem de outra palavra. */
const PATH_TOKEN = new RegExp(`(?<![\\w:/.@~-])(?:\\.{1,2}/)*(?:\\.?[A-Za-z0-9_@-][A-Za-z0-9_.@-]*/)*\\.?[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.(?:${EXTENSIONS})(?![\\w/-])`, 'g')
const FILE_TOKEN = /\{file:([^}\s]+)\}/g
const MARKDOWN_LINK = /\]\(([^)\s#?]+)(?:[#?][^)\s]*)?\)/g
const URL = /^[a-z][a-z0-9+.-]*:/i

/** Os `{file:…}` do texto (o opencode põe o prompt do agente num arquivo assim). */
export function fileTokens(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN)].map((match) => match[1]))]
}

/** Os caminhos citados, na ordem em que aparecem, sem repetir. */
export function extractCitations(text: string): string[] {
  const found = new Set<string>()
  const add = (raw: string) => {
    const clean = raw.trim().replace(/^<|>$/g, '')
    if (!clean || URL.test(clean) || clean.startsWith('#')) return
    found.add(clean)
  }
  for (const match of text.matchAll(FILE_TOKEN)) add(match[1])
  for (const match of text.matchAll(MARKDOWN_LINK)) if (/\.[A-Za-z0-9]{1,8}$/.test(match[1])) add(match[1])
  for (const match of text.matchAll(PATH_TOKEN)) add(match[0])
  return [...found]
}

/** O marcador de arquivo gerado, no cabeçalho. */
const GENERATED = /AUTO-?GERADO|AUTO-?GENERATED|DO NOT EDIT|N[ÃA]O EDITAR/i

/** Arquivo GERADO (marcador nas primeiras 15 linhas)? Devolve as fontes que o bloco do marcador cita (pode ser vazio); `undefined` = não é gerado. */
export function generatedSources(text: string): string[] | undefined {
  const lines = text.slice(0, 3000).split('\n').slice(0, 15)
  const at = lines.findIndex((line) => GENERATED.test(line))
  if (at < 0) return undefined
  // O cabeçalho é o bloco do marcador: dele até a primeira linha em branco.
  const end = lines.findIndex((line, index) => index > at && !line.trim())
  return extractCitations(lines.slice(at, end < 0 ? undefined : end).join('\n'))
}

/**
 * O caminho real de uma citação, ou `undefined` (referência quebrada). Tenta, nesta ordem: relativo ao arquivo que cita,
 * relativo à raiz e relativo a `.agents/` (o `specs/x.md` dito de dentro do formato). ⛔ Nunca sai da raiz.
 */
export function resolveCitation(cited: string, fromPath: string, resolve: (path: string) => string | undefined): string | undefined {
  const clean = cited.replace(/\\/g, '/')
  // `~` é a máquina de alguém; `/x.md` dito no repositório é a partir da raiz (o `replace` abaixo).
  if (clean.startsWith('~')) return undefined
  const candidates = [posix.join(posix.dirname(fromPath), clean), posix.normalize(clean.replace(/^\/+/, '')), posix.join('.agents', clean.replace(/^\/+/, ''))]
  for (const candidate of candidates) {
    const normal = posix.normalize(candidate).replace(/^\.\//, '')
    if (!normal || normal === '.' || normal.startsWith('../') || normal === '..' || posix.isAbsolute(normal)) continue
    const real = resolve(normal)
    if (real) return real
  }
  return undefined
}

/** O slug pelo padrão do gateway: minúsculas, sem acento, `-` no lugar do resto, cortado no limite do tipo. */
export function candidateId(kind: TInventoryKind, name: string): { id: string; cut: boolean } {
  const slug =
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  const padded = slug.length < 2 ? `${slug}-item` : slug
  const max = CANDIDATE_ID_MAX[kind]
  if (!max || padded.length <= max) return { id: padded, cut: false }
  return { id: padded.slice(0, max).replace(/-+$/g, ''), cut: true }
}

/**
 * O frontmatter (`---` … `---`) de um markdown, só o nível de cima e como texto: `chave: valor`. Suficiente para o
 * detector saber o `agent:`, o `description:` e o `model:`; não é um leitor de YAML.
 */
export function frontmatter(text: string): Record<string, string> {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].trim().replace(/^["']|["']$/g, '')
  }
  return fields
}

/** O primeiro título (`# …`) do markdown, sem o frontmatter. */
export function firstHeading(text: string): string | undefined {
  return /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))?.[1]
}
