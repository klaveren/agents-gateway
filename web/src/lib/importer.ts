/**
 * O IMPORTADOR na tela: o inventário que `POST /projects/:id/import/scan` devolve (o espelho de
 * `ImportInventory.Model.ts`) e as contas da tela — filtros, agrupamento, contagens e a reclassificação local.
 *
 * ⚖️ Puro e barato: um repositório grande dá ~730 itens e ~9700 arquivos. O texto de busca de cada item é montado
 * uma vez por análise (`searchIndex`), não a cada tecla.
 *
 * ⛔ Reclassificar aqui é SÓ NA TELA: vale para a análise aberta e some ao analisar de novo. Persistir é do PR 6.
 */

export type TInventoryKind = 'skill' | 'command' | 'rule' | 'spec' | 'adr' | 'knowledge' | 'agent' | 'trigger' | 'mcp' | 'config' | 'unknown' | 'skip'
export type TCatalogState = 'new' | 'same-project' | 'global' | 'other-project'
export type TNoteLevel = 'info' | 'attention' | 'untranslatable'

export interface IInventoryNote {
  level: TNoteLevel
  code: string
  text: string
}

/** Um arquivo que alimenta o item. ⛔ Nunca leva o conteúdo: só o metadado. */
export interface IInventorySource {
  path: string
  aliases: string[]
  bytes: number
  tokens: number
  sha256: string
  role?: string
  generated?: string[]
  secret?: boolean
}

export interface IInventoryRef {
  path: string
  item?: string
}

export interface IInventoryItem {
  key: string
  kind: TInventoryKind
  parent?: string
  candidateId: string
  title?: string
  detectors: string[]
  sources: IInventorySource[]
  refs: IInventoryRef[]
  unresolved: string[]
  catalog?: TCatalogState
  notes: IInventoryNote[]
}

export interface IInventoryLink {
  path: string
  reason: 'outside' | 'cycle' | 'broken'
}

export interface IImportScan {
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: string
  formats: string[]
  totals: { files: number; items: number; tokens: number; byKind: Partial<Record<TInventoryKind, number>> }
  ignored: { dirs: Record<string, number>; binaries: string[]; links: IInventoryLink[] }
  items: IInventoryItem[]
}

/** A ordem dos tipos na tela: o que vai ao catálogo primeiro, o resto depois. */
export const KIND_ORDER: readonly TInventoryKind[] = ['agent', 'trigger', 'skill', 'command', 'rule', 'spec', 'adr', 'knowledge', 'mcp', 'config', 'unknown', 'skip']

export const KIND_LABEL: Record<TInventoryKind, string> = {
  agent: 'Agente',
  trigger: 'Trigger',
  skill: 'Skill',
  command: 'Command',
  rule: 'Rule',
  spec: 'Spec',
  adr: 'ADR',
  knowledge: 'Knowledge',
  mcp: 'MCP',
  config: 'Configuração',
  unknown: 'Desconhecido',
  skip: 'Pulado',
}

export const CATALOG_LABEL: Record<TCatalogState, string> = {
  new: 'novo',
  'same-project': 'já no projeto',
  global: 'já global',
  'other-project': 'em outro projeto',
}

export const CATALOG_HINT: Record<TCatalogState, string> = {
  new: 'O id ainda não existe no catálogo',
  'same-project': 'Já existe neste projeto com o mesmo id',
  global: 'Já existe um global com o mesmo id',
  'other-project': 'Conflito: o id já existe em outro projeto e precisa mudar antes de importar',
}

export const LINK_REASON_LABEL: Record<IInventoryLink['reason'], string> = { outside: 'aponta para fora', cycle: 'em ciclo', broken: 'quebrado' }

/** As reclassificações da tela: chave do item → tipo escolhido. */
export type TOverrides = Readonly<Record<string, TInventoryKind>>

export function effectiveKind(item: IInventoryItem, overrides: TOverrides): TInventoryKind {
  return overrides[item.key] ?? item.kind
}

/** O filtro de notas: todas, só com alerta, só "não traduz", ou um código (`code:broken-ref`). */
export type TNoteFilter = '' | 'attention' | 'untranslatable' | `code:${string}`
/** O filtro de estado: qualquer, um estado, ou `none` (tipo que não vai ao catálogo). */
export type TCatalogFilter = '' | TCatalogState | 'none'

export interface IImportFilters {
  kind: TInventoryKind | ''
  catalog: TCatalogFilter
  note: TNoteFilter
  query: string
}

export const EMPTY_FILTERS: IImportFilters = { kind: '', catalog: '', note: '', query: '' }

/** O texto em que a busca procura: chave, id, título e os caminhos (com os aliases) — em minúsculas. */
export function searchText(item: IInventoryItem): string {
  const parts = [item.key, item.candidateId, item.title ?? '']
  for (const source of item.sources) parts.push(source.path, ...source.aliases)
  return parts.join('\n').toLowerCase()
}

export function searchIndex(items: readonly IInventoryItem[]): Map<string, string> {
  return new Map(items.map((item) => [item.key, searchText(item)]))
}

function matchesNote(item: IInventoryItem, note: TNoteFilter): boolean {
  if (!note) return true
  if (note === 'attention' || note === 'untranslatable') return item.notes.some((entry) => entry.level === note)
  const code = note.slice('code:'.length)
  return item.notes.some((entry) => entry.code === code)
}

export function filterItems(items: readonly IInventoryItem[], filters: IImportFilters, overrides: TOverrides = {}, index?: Map<string, string>): IInventoryItem[] {
  const terms = filters.query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    if (filters.kind && effectiveKind(item, overrides) !== filters.kind) return false
    if (filters.catalog === 'none' ? item.catalog !== undefined : filters.catalog && item.catalog !== filters.catalog) return false
    if (!matchesNote(item, filters.note)) return false
    if (!terms.length) return true
    const text = index?.get(item.key) ?? searchText(item)
    return terms.every((term) => text.includes(term))
  })
}

export function itemTokens(item: IInventoryItem): number {
  return item.sources.reduce((sum, source) => sum + source.tokens, 0)
}

export function itemBytes(item: IInventoryItem): number {
  return item.sources.reduce((sum, source) => sum + source.bytes, 0)
}

export type TImportSort = 'kind' | 'key' | 'tokens'

function kindRank(kind: TInventoryKind): number {
  const rank = KIND_ORDER.indexOf(kind)
  return rank < 0 ? KIND_ORDER.length : rank
}

export function sortItems(items: readonly IInventoryItem[], sort: TImportSort, overrides: TOverrides = {}): IInventoryItem[] {
  const out = [...items]
  if (sort === 'key') return out.sort((a, b) => a.key.localeCompare(b.key))
  if (sort === 'tokens') return out.sort((a, b) => itemTokens(b) - itemTokens(a) || a.key.localeCompare(b.key))
  return out.sort((a, b) => kindRank(effectiveKind(a, overrides)) - kindRank(effectiveKind(b, overrides)) || a.key.localeCompare(b.key))
}

export interface IKindGroup {
  kind: TInventoryKind
  items: IInventoryItem[]
}

/** Agrupa pelo tipo (já reclassificado), na ordem de `KIND_ORDER`; a ordem dentro do grupo é a de entrada. */
export function groupByKind(items: readonly IInventoryItem[], overrides: TOverrides = {}): IKindGroup[] {
  const groups = new Map<TInventoryKind, IInventoryItem[]>()
  for (const item of items) {
    const kind = effectiveKind(item, overrides)
    const list = groups.get(kind)
    if (list) list.push(item)
    else groups.set(kind, [item])
  }
  return [...groups.entries()].sort(([a], [b]) => kindRank(a) - kindRank(b)).map(([kind, list]) => ({ kind, items: list }))
}

/** Quantos itens por tipo (já reclassificado). */
export function countByKind(items: readonly IInventoryItem[], overrides: TOverrides = {}): Array<{ kind: TInventoryKind; count: number }> {
  return groupByKind(items, overrides).map((group) => ({ kind: group.kind, count: group.items.length }))
}

export function countByCatalog(items: readonly IInventoryItem[]): Record<TCatalogState | 'none', number> {
  const out: Record<TCatalogState | 'none', number> = { new: 0, 'same-project': 0, global: 0, 'other-project': 0, none: 0 }
  for (const item of items) out[item.catalog ?? 'none'] += 1
  return out
}

/** Os códigos de nota da análise, com o nível mais grave e quantos itens têm cada um; os mais graves primeiro. */
export function noteCodes(items: readonly IInventoryItem[]): Array<{ code: string; level: TNoteLevel; count: number }> {
  const severity: Record<TNoteLevel, number> = { untranslatable: 0, attention: 1, info: 2 }
  const codes = new Map<string, { code: string; level: TNoteLevel; count: number }>()
  for (const item of items) {
    const seen = new Set<string>()
    for (const note of item.notes) {
      const entry = codes.get(note.code) ?? { code: note.code, level: note.level, count: 0 }
      if (severity[note.level] < severity[entry.level]) entry.level = note.level
      if (!seen.has(note.code)) entry.count += 1
      seen.add(note.code)
      codes.set(note.code, entry)
    }
  }
  return [...codes.values()].sort((a, b) => severity[a.level] - severity[b.level] || b.count - a.count || a.code.localeCompare(b.code))
}

/** Quem cita cada item: chave citada → chaves dos itens que a citam (sem repetir, sem o próprio item). */
export function citedBy(items: readonly IInventoryItem[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>()
  for (const item of items)
    for (const ref of item.refs) {
      if (!ref.item || ref.item === item.key) continue
      const set = out.get(ref.item) ?? new Set<string>()
      set.add(item.key)
      out.set(ref.item, set)
    }
  return new Map([...out.entries()].map(([key, set]) => [key, [...set].sort()]))
}

/** As pastas ignoradas, as mais cheias primeiro. */
export function ignoredDirs(dirs: Record<string, number>): Array<{ name: string; count: number }> {
  return Object.entries(dirs)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export function bytesLabel(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} KB`
  return `${value} B`
}

/** O que a pessoa pode escolher ao reclassificar: todos os tipos. */
export const RECLASSIFY_KINDS: readonly TInventoryKind[] = KIND_ORDER
