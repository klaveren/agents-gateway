import { posix } from 'node:path'
import { CANDIDATE_ID_MAX, TInventoryKind } from './models/ImportInventory.Model'

/**
 * As CITAÇÕES de um arquivo importado: os caminhos que o texto cita (`.agents/specs/x.md`, `specs/x.md`, `{file:…}`,
 * link de markdown, lista de dependências em YAML). Puro: quem diz se o arquivo existe é a árvore (`resolve`).
 */

const EXTENSIONS = 'md|mdx|mdc|markdown|ya?ml|jsonc?|toml|txt'
/**
 * Um pedaço CORINGA ou MARCADOR dentro de um nome: glob (`*`, `?`, `[…]`), `{x}`, `<x>`, `$X`/`${X}`, `%X%`, `...`. Entra
 * no token para o caminho sair INTEIRO (`{alias}-memory.md`, não o caco `-memory.md`) e ser classificado depois.
 */
const WILD = String.raw`\*{1,2}|\?|\[[^\]\s/]*\]|\{[^{}\s/]*\}|<[^<>\s/]+>|\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%|\.\.\.`
const SEGMENT = String.raw`(?:[A-Za-z0-9_.@-]|${WILD})+`
/**
 * Um caminho com extensão de texto. O lado esquerdo não pode ser parte de URL nem de outra palavra (nem continuação de
 * coringa ou marcador: `*`, `}`, `>`, `]`, `$`). Pode começar por `/` ou `~/` (absoluto: decidido na resolução).
 */
const PATH_TOKEN = new RegExp(String.raw`(?<![\w:/.@~*}>\]$%-])(?:~?\/)?(?:${SEGMENT}\/)*${SEGMENT}\.(?:${EXTENSIONS})(?![\w/-])`, 'g')
const FILE_TOKEN = /\{file:([^}\s]+)\}/g
const MARKDOWN_LINK = /\]\(([^)\s#?]+)(?:[#?][^)\s]*)?\)/g
const URL = /^[a-z][a-z0-9+.-]*:/i
/** Abre ou fecha um bloco de código cercado (até 3 espaços de recuo). */
const FENCE = /^ {0,3}(`{3,}|~{3,})/
/** Linha de árvore de pastas desenhada (`├── a.md`): é ilustração, não citação. */
const TREE_DRAWING = /[├└│┌┐┘┬┴┼]/

/** Uma citação achada no texto. `example`: TODA vez que aparece é em bloco de código ou árvore desenhada. `call`: seguida de `(` (`r.json()`). */
export interface ICitation {
  cited: string
  example?: true
  call?: true
}

/** Os `{file:…}` do texto (o opencode põe o prompt do agente num arquivo assim). */
export function fileTokens(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN)].map((match) => match[1]))]
}

/**
 * As citações do texto, na ordem em que aparecem, sem repetir, com o contexto: em exemplo (bloco cercado, árvore
 * desenhada) ou chamada de código. ⚖️ O exemplo NÃO é descartado aqui: caminho real em bloco de código existe e resolve;
 * o contexto só decide o que fazer quando NÃO resolve. A URL vem (para ser contada), e não é caminho.
 */
export function citationsIn(text: string): ICitation[] {
  const found = new Map<string, ICitation>()
  const add = (raw: string, example: boolean, call: boolean) => {
    // `@arquivo` é a importação do Claude Code (`@AGENTS.md`): o caminho é o que vem depois do `@`.
    const clean = raw
      .trim()
      .replace(/^<([^<>]*)>$/, '$1')
      .replace(/^@(?=[\w.])/, '')
    if (!clean || clean.startsWith('#')) return
    const known = found.get(clean)
    if (!known) {
      found.set(clean, { cited: clean, ...(example ? { example: true } : {}), ...(call ? { call: true } : {}) })
      return
    }
    // Uma vez fora do exemplo (ou fora de chamada) basta para valer como citação de verdade.
    if (!example) delete known.example
    if (!call) delete known.call
  }
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker
      continue
    }
    const example = !!fence || TREE_DRAWING.test(line)
    for (const match of line.matchAll(FILE_TOKEN)) add(match[1], example, false)
    for (const match of line.matchAll(MARKDOWN_LINK)) if (/\.[A-Za-z0-9]{1,8}$/.test(match[1])) add(match[1], example, false)
    for (const match of line.matchAll(PATH_TOKEN)) add(match[0], example, line[match.index + match[0].length] === '(')
  }
  return [...found.values()]
}

/** Os caminhos citados, na ordem em que aparecem, sem repetir (sem URL). */
export function extractCitations(text: string): string[] {
  return citationsIn(text)
    .map((citation) => citation.cited)
    .filter((cited) => !URL.test(cited))
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

/**
 * Por que uma citação que NÃO resolve não é referência quebrada. ⚖️ Nada some em silêncio: cada uma vira contagem numa
 * nota de nível baixo (`ignored-ref`).
 * - `url`: endereço, não caminho;
 * - `glob`: padrão (`*.md`, `a/?.md`, `[id].md`, `{a,b}.md`);
 * - `placeholder`: marcador (`{alias}-soul.md`, `<nome>.md`, `$DIR/x.md`, `.../x.md`, `IMP-XXX.md`, `path/to/x.md`, `{file:path}`);
 * - `fragment`: sufixo ou extensão solto (`-02.md`, `.gen.md`);
 * - `code`: chamada de código (`r.json()`);
 * - `outside`: absoluto da máquina de alguém (`/Users/…`, `/home/…`, `~/…`) ou relativo que sobe acima da raiz;
 * - `example`: só aparece em bloco de código ou árvore desenhada;
 * - `ambiguous`: o nome existe em mais de um lugar e nada diz qual.
 */
export type TRefSkip = 'url' | 'glob' | 'placeholder' | 'fragment' | 'code' | 'outside' | 'example' | 'ambiguous'

/** O texto de cada motivo, na ordem em que a nota os lista. */
export const REF_SKIP_TEXT: Readonly<Record<TRefSkip, string>> = {
  example: 'em exemplo',
  placeholder: 'marcador',
  glob: 'padrão glob',
  fragment: 'sufixo solto',
  ambiguous: 'nome ambíguo',
  outside: 'fora do repositório',
  code: 'código',
  url: 'URL',
}

export type TCitationResult = { found: string; byName?: true } | { skip: TRefSkip } | { broken: true }

/** A primeira pasta de um absoluto que é da máquina, não do repositório. */
const HOST_ROOTS = new Set([
  'Users',
  'home',
  'root',
  'tmp',
  'var',
  'etc',
  'opt',
  'usr',
  'private',
  'Volumes',
  'mnt',
  'media',
  'srv',
  'Library',
  'System',
  'Applications',
  'proc',
  'dev',
  'run',
  'nix',
  'snap',
  'bin',
  'sbin',
  'workspace',
  'workspaces',
])
/** Pedaço de nome que é marcador por convenção: `XXX`, `NNN`, `YYYY`, `MM`, `DD`. */
const PLACEHOLDER_PART = /^(?:X{2,}|N{2,}|Y{2,4}|M{2}|D{2}|x{3,})$/
/** O nome inteiro é a palavra genérica (`{file:path}`, `filename.md`). */
const PLACEHOLDER_NAME = /^(?:path|file|filename|filepath|arquivo|caminho)(?:\.[A-Za-z0-9]+)?$/i

/** É ruído (e de que tipo), pela forma só — sem olhar a árvore. */
export function citationNoise(cited: string): TRefSkip | undefined {
  if (URL.test(cited) && !/^[A-Za-z]:[\\/]/.test(cited)) return 'url'
  if (/[*?]|\[[^\]]*\]|\{[^{}]*,[^{}]*\}/.test(cited)) return 'glob'
  const segments = cited.split(/[\\/]/)
  if (
    /\{[^{}]*\}|<[^<>]+>|\$\{?[A-Za-z_]|%[A-Za-z_]\w*%/.test(cited) ||
    segments.some((segment) => segment === '...' || segment === '…') ||
    /(?:^|\/)path\/to\//.test(cited) ||
    PLACEHOLDER_NAME.test(cited) ||
    segments.some((segment) => segment.split(/[-_.]/).some((part) => PLACEHOLDER_PART.test(part)))
  )
    return 'placeholder'
  if (segments.length === 1 && (/^-/.test(cited) || /^\.[^.]+\.[^.]+$/.test(cited))) return 'fragment'
  return undefined
}

/** Absoluto da máquina (`/Users/…`, `~/…`, `C:\…`): nunca é do repositório. */
function isHostPath(cited: string): boolean {
  if (/^~|^[A-Za-z]:[\\/]/.test(cited)) return true
  return cited.startsWith('/') && HOST_ROOTS.has(cited.split('/').filter(Boolean)[0] ?? '')
}

/**
 * ONDE está o arquivo de uma citação — ou por que não é referência quebrada, ou que é. Nesta ordem:
 * 1. `resolveCitation` (o arquivo que cita, a raiz, o `.agents/`);
 * 2. ruído pela forma (`citationNoise`), chamada de código, absoluto da máquina;
 * 3. relativo a uma pasta ACIMA do arquivo que cita (o `maya-soul.md` dito de dentro de `triggers/`);
 * 4. pelo NOME: o único arquivo da árvore que termina no caminho citado (`akm-agent-anatomy.md` → `.agents/specs/core/…`);
 * 5. só em exemplo → `example`; o nome existe em mais de um lugar → `ambiguous`; senão, quebrada.
 *
 * `byName`: os caminhos reais da árvore com aquele nome de arquivo. ⛔ Nunca sai da raiz.
 */
export function locateCitation(citation: ICitation, fromPath: string, resolve: (path: string) => string | undefined, byName: (name: string) => readonly string[]): TCitationResult {
  const cited = citation.cited.replace(/\\/g, '/')
  const direct = resolveCitation(cited, fromPath, resolve)
  if (direct) return { found: direct }
  const noise = citationNoise(citation.cited)
  if (noise) return { skip: noise }
  if (citation.call) return { skip: 'code' }
  // Absoluto da máquina, ou relativo que sobe acima da raiz (`../outro-repo/x.md`): fora do repositório.
  if (isHostPath(cited) || /^\.\.(?:\/|$)/.test(posix.normalize(posix.join(posix.dirname(fromPath), cited)))) return { skip: 'outside' }
  const relative = cited.replace(/^\/+/, '')
  for (let dir = posix.dirname(posix.dirname(fromPath)); dir !== '.' && dir !== '/' && dir; dir = posix.dirname(dir)) {
    const normal = posix.normalize(posix.join(dir, relative))
    if (normal.startsWith('../') || normal === '..') continue
    const real = resolve(normal)
    if (real) return { found: real }
  }
  // O sufixo: sem `./` nem `../` na frente; casa por pasta inteira (`b/x.md` não casa `ab/x.md`).
  const tail = posix.normalize(relative).replace(/^(?:\.\.?\/)+/, '')
  const name = posix.basename(tail)
  const matches = name && tail !== '.' ? byName(name).filter((path) => path === tail || path.endsWith(`/${tail}`)) : []
  if (matches.length === 1) return { found: matches[0], byName: true }
  if (citation.example) return { skip: 'example' }
  if (matches.length > 1) return { skip: 'ambiguous' }
  return { broken: true }
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
