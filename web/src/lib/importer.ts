/**
 * O IMPORTADOR na tela: o inventário que a varredura devolve (o espelho de `ImportInventory.Model.ts`), o TRABALHO DE
 * IMPORTAÇÃO (a varredura salva, com o estado de cada item — `ImportJob.Model.ts`) e as contas da tela — filtros,
 * agrupamento e contagens.
 *
 * ⚖️ Puro e barato: um repositório grande dá ~730 itens e ~9700 arquivos. O texto de busca de cada item é montado
 * uma vez por análise (`searchIndex`), não a cada tecla.
 *
 * A reclassificação e o excluir/incluir são do trabalho (persistem no servidor); a reanálise os reaproveita pela chave.
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
  /** O estado do item no trabalho. */
  state?: TImportItemState | ''
}

export const EMPTY_FILTERS: IImportFilters = { kind: '', catalog: '', note: '', query: '', state: '' }

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

export function filterItems(
  items: readonly IInventoryItem[],
  filters: IImportFilters,
  overrides: TOverrides = {},
  index?: Map<string, string>,
  states?: ReadonlyMap<string, IImportItemStatus>,
): IInventoryItem[] {
  const terms = filters.query.toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    if (filters.state && (states?.get(item.key)?.state ?? 'pending') !== filters.state) return false
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

// ── O TRABALHO DE IMPORTAÇÃO (`/projects/:id/import/jobs`, espelho de `ImportJob.Model.ts`). ⛔ Não grava no catálogo. ─

export type TImportItemState = 'pending' | 'drafting' | 'review' | 'approved' | 'rejected' | 'skipped' | 'applied' | 'error' | 'stale'

export const STATE_ORDER: readonly TImportItemState[] = ['pending', 'stale', 'drafting', 'review', 'error', 'approved', 'rejected', 'applied', 'skipped']

export const STATE_LABEL: Record<TImportItemState, string> = {
  pending: 'a importar',
  drafting: 'no construtor',
  review: 'a revisar',
  approved: 'aprovado',
  rejected: 'rejeitado',
  skipped: 'excluído',
  applied: 'aplicado',
  error: 'erro',
  stale: 'fonte mudou',
}

export const STATE_HINT: Record<TImportItemState, string> = {
  pending: 'Entra na importação',
  drafting: 'O construtor está escrevendo o rascunho',
  review: 'Há rascunho a revisar',
  approved: 'Aprovado; ainda não gravado no catálogo',
  rejected: 'O rascunho foi rejeitado',
  skipped: 'Fica fora da importação',
  applied: 'Gravado no catálogo',
  error: 'O construtor falhou',
  stale: 'A fonte mudou depois da última decisão: decida de novo',
}

/** Os estados de onde a pessoa exclui o item e de onde o inclui de novo (as transições do servidor, `Import.Job.ts`). */
export const EXCLUDABLE_STATES: readonly TImportItemState[] = ['pending', 'rejected', 'error', 'stale']
export const INCLUDABLE_STATES: readonly TImportItemState[] = ['skipped', 'stale']
/** Reclassificar só sem rascunho no caminho. */
export const RECLASSIFIABLE_STATES: readonly TImportItemState[] = ['pending', 'skipped', 'rejected', 'error', 'stale']

export interface IImportItemStatus {
  key: string
  state: TImportItemState
  staleFrom?: TImportItemState
  /** A reclassificação gravada (ausente = o tipo detectado). */
  kind?: TInventoryKind
  fingerprint: string
  /** O lote do catálogo em que o item entrou (`applied`). */
  batchId?: string
  by?: string
  at?: string
}

export interface IImportReuse {
  from: string
  kept: number
  stale: string[]
  restored: string[]
  added: string[]
  gone: string[]
}

export interface IImportJobSummary {
  id: string
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: string
  by: string
  previousId?: string
  items: number
  byState: Partial<Record<TImportItemState, number>>
  /** O mais novo do repositório: só ele muda. */
  latest: boolean
  reuse?: IImportReuse
}

export interface IImportJob extends IImportJobSummary {
  scan: IImportScan
  states: IImportItemStatus[]
}

/** O estado de cada item, pela chave. */
export function statesByKey(states: readonly IImportItemStatus[]): Map<string, IImportItemStatus> {
  return new Map(states.map((entry) => [entry.key, entry]))
}

/** As reclassificações gravadas no trabalho, no formato da tela. */
export function overridesFrom(states: readonly IImportItemStatus[]): Record<string, TInventoryKind> {
  const out: Record<string, TInventoryKind> = {}
  for (const entry of states) if (entry.kind) out[entry.key] = entry.kind
  return out
}

/** Quantos itens em cada estado, na ordem de `STATE_ORDER` (só os que têm algum). */
export function countByState(byState: Partial<Record<TImportItemState, number>>): Array<{ state: TImportItemState; count: number }> {
  return STATE_ORDER.filter((state) => (byState[state] ?? 0) > 0).map((state) => ({ state, count: byState[state]! }))
}

// ── O LOTE de um agente (`POST /projects/:id/import/plan`, espelho de `ImportPlan.Model.ts`). ⛔ Só leitura. ─────────

export type TPlanPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type TPlanIdState = 'new' | 'update' | 'conflict' | 'duplicate'
export type TReachStatus = 'direct' | 'changed' | 'none'

export interface IPermissionRuleView {
  category: string
  pattern: string
  decision: 'allow' | 'deny'
  note?: string
}

export interface IReachLine {
  origin: 'agent' | 'project' | 'option'
  key: string
  pattern: string
  action: string
  rules: IPermissionRuleView[]
  status: TReachStatus
  reason: string
  widening?: string
}

export interface IReachToolLine {
  key: string
  enabled: boolean
  tools: string[]
  status: TReachStatus
  reason: string
}

export interface IReachWidening {
  rule: IPermissionRuleView
  reason: string
}

export interface IReachTranslation {
  lines: IReachLine[]
  added: IReachLine[]
  rules: IPermissionRuleView[]
  widenings: IReachWidening[]
  tools: IReachToolLine[]
  allowedTools: string[]
  totals: Record<TReachStatus, number>
}

export interface IPlanStep {
  phase: TPlanPhase
  key: string
  kind: TInventoryKind
  id: string
  title?: string
  why: 'agent' | 'trigger' | 'cited' | 'instructions' | 'selected'
  citedBy: string[]
  dependsOn: string[]
  forward: string[]
  tokens: { sources: number; protocol: number }
  state: TPlanIdState
  /** Já feito (no catálogo, ou aprovado neste trabalho): sem conversa e fora da estimativa. */
  done?: TPlanDone
  notes: IInventoryNote[]
}

export type TPlanDone = 'catalog' | 'approved'

export interface IPlanIdEntry {
  key: string
  kind: TInventoryKind
  sourceId: string
  id: string
  title?: string
  parent?: string
  prefixed: boolean
  cut: boolean
  catalog?: TCatalogState
  state: TPlanIdState
  reason?: string
}

export interface IPlanExclusion {
  from: string
  reason: 'broken' | 'no-item' | 'other-agent' | 'unclassified' | 'out-of-catalog' | 'config' | 'untranslatable'
  path?: string
  item?: string
  code?: string
  text: string
}

export interface IPlanLink {
  name: string
  key?: string
  id: string
  state: 'exists' | 'pending' | 'unknown'
  cycle: boolean
  text: string
}

export interface IPlanReach {
  format: 'opencode'
  sourceName: string
  translation: IReachTranslation
  skills: { proposed: string[]; from: 'agent-rules' | 'cited'; notReleased: string[]; pending: string[]; note: string }
  notes: IInventoryNote[]
}

export interface IPlanEstimateEntry {
  conversations: number
  inputTokens: number
}

export interface IPlanEstimate extends IPlanEstimateEntry {
  sourceTokens: number
  protocolTokens: number
  byKind: Partial<Record<TInventoryKind, IPlanEstimateEntry>>
  /** Os passos já feitos, fora da conta. */
  done?: number
  released: IPlanEstimateEntry
  note: string
}

export interface IPlanPhaseInfo {
  phase: TPlanPhase
  label: string
  steps: number
}

export interface IPlanCycle {
  keys: string[]
  brokenBy: 'order'
  text: string
}

export interface IImportPlan {
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  plannedAt: string
  agent: string
  prefix: string
  phases: IPlanPhaseInfo[]
  steps: IPlanStep[]
  links: IPlanLink[]
  reach?: IPlanReach
  project?: { lines: IReachLine[]; widenings: IReachWidening[]; notes: IInventoryNote[] }
  idMap: IPlanIdEntry[]
  excluded: IPlanExclusion[]
  released: Array<{ key: string; id: string; tokens: number; catalog?: TCatalogState }>
  mcps: Array<{ name: string; key?: string; id: string; exists: boolean }>
  cycles: IPlanCycle[]
  estimate: IPlanEstimate
  blocked: string[]
  notes: IInventoryNote[]
}

// ── O LOTE POR SELEÇÃO de um trabalho (`/projects/:id/import/jobs/:job/batches`). ⛔ Não grava no catálogo. ───────────

/** Para onde aponta uma citação que sai da seleção. */
export type TOutsideState = 'catalog' | 'approved' | 'batch' | 'missing' | 'broken' | 'not-importable'

export interface IPlanOutside {
  from: string
  state: TOutsideState
  item?: string
  path?: string
  id?: string
  batch?: { id: string; name: string }
  text: string
}

export interface ISelectionPlan {
  keys: string[]
  prefix: string
  phases: IPlanPhaseInfo[]
  steps: IPlanStep[]
  idMap: IPlanIdEntry[]
  cycles: IPlanCycle[]
  outside: IPlanOutside[]
  excluded: IPlanExclusion[]
  estimate: IPlanEstimate
  blocked: string[]
  notes: IInventoryNote[]
}

/** Um lote salvo no trabalho: a seleção, com nome, ordem, quem e quando. */
export interface IImportBatch {
  id: string
  jobId: string
  name: string
  prefix: string
  keys: string[]
  order: string[]
  by: string
  at: string
}

/** O lote salvo, aberto: com o lote recalculado sobre o estado de agora. */
export interface IImportBatchView extends IImportBatch {
  plan: ISelectionPlan
}

export const DONE_LABEL: Record<TPlanDone, string> = { catalog: 'já no catálogo', approved: 'já aprovado' }

export const OUTSIDE_LABEL: Record<TOutsideState, string> = {
  broken: 'citação quebrada',
  missing: 'falta importar',
  'not-importable': 'não vai ao catálogo',
  batch: 'em outro lote',
  approved: 'já aprovado neste trabalho',
  catalog: 'já no catálogo',
}

/** As citações para fora da seleção, por estado (as que pedem ação primeiro). */
export function outsideByState(outside: readonly IPlanOutside[]): Array<{ state: TOutsideState; entries: IPlanOutside[] }> {
  const order: TOutsideState[] = ['broken', 'missing', 'not-importable', 'batch', 'approved', 'catalog']
  return order.map((state) => ({ state, entries: outside.filter((entry) => entry.state === state) })).filter((group) => group.entries.length)
}

/** Um nome de lote a partir da seleção: o tipo, quando é um só, e quantos. */
export function batchName(items: readonly IInventoryItem[], overrides: TOverrides = {}): string {
  const kinds = [...new Set(items.map((item) => effectiveKind(item, overrides)))]
  const what = kinds.length === 1 ? KIND_LABEL[kinds[0]] : 'Seleção'
  return `${what} (${items.length})`
}

export const REACH_MARK: Record<TReachStatus, string> = { direct: '✅', changed: '⚠️', none: '❌' }
export const REACH_STATUS_LABEL: Record<TReachStatus, string> = { direct: 'traduz direto', changed: 'traduz com mudança', none: 'não entra' }

export const ID_STATE_LABEL: Record<TPlanIdState, string> = { new: 'novo', update: 'atualiza', conflict: 'conflito', duplicate: 'duplicado' }

export const WHY_LABEL: Record<IPlanStep['why'], string> = {
  agent: 'o agente',
  trigger: 'trigger do agente',
  cited: 'citado',
  instructions: 'instructions do opencode',
  selected: 'escolhido',
}

export const EXCLUSION_LABEL: Record<IPlanExclusion['reason'], string> = {
  broken: 'citação quebrada',
  'no-item': 'arquivo sem item',
  'other-agent': 'outro agente',
  unclassified: 'desconhecido',
  'out-of-catalog': 'fora do catálogo',
  config: 'configuração',
  untranslatable: 'não traduz',
}

/** O prefixo de id: o mesmo padrão do servidor (`IMPORT_PREFIX_PATTERN`). Vazio vale (sem prefixo). */
export function prefixIssue(prefix: string): string | undefined {
  const clean = prefix.trim().toLowerCase()
  if (!clean || /^[a-z0-9][a-z0-9-]{0,15}$/.test(clean)) return undefined
  return 'minúsculas, dígitos e "-", até 16 caracteres'
}

/** Os passos agrupados por fase (só as fases com passo), na ordem do lote. */
export function stepsByPhase(plan: Pick<IImportPlan, 'phases' | 'steps'>): Array<{ phase: TPlanPhase; label: string; steps: IPlanStep[] }> {
  return plan.phases
    .map((phase) => ({ phase: phase.phase, label: phase.label, steps: plan.steps.filter((step) => step.phase === phase.phase) }))
    .filter((group) => group.steps.length)
}

/** O que fica de fora, por motivo (os mais graves primeiro). */
export function exclusionsByReason(excluded: readonly IPlanExclusion[]): Array<{ reason: IPlanExclusion['reason']; entries: IPlanExclusion[] }> {
  const order: Array<IPlanExclusion['reason']> = ['broken', 'untranslatable', 'other-agent', 'unclassified', 'no-item', 'out-of-catalog', 'config']
  return order.map((reason) => ({ reason, entries: excluded.filter((entry) => entry.reason === reason) })).filter((group) => group.entries.length)
}

/** As linhas do alcance numa tabela só: as do agente, as acrescentadas e as do projeto, cada uma com a origem. */
export function reachRows(plan: IImportPlan): Array<IReachLine & { layer: 'agente' | 'acrescentada' | 'projeto' }> {
  return [
    ...(plan.reach?.translation.lines ?? []).map((line) => ({ ...line, layer: 'agente' as const })),
    ...(plan.reach?.translation.added ?? []).map((line) => ({ ...line, layer: 'acrescentada' as const })),
    ...(plan.project?.lines ?? []).map((line) => ({ ...line, layer: 'projeto' as const })),
  ]
}
