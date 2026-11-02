<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import { routerKey } from 'vue-router'
import ImportApply from '@/components/ImportApply.vue'
import ImportBatch from '@/components/ImportBatch.vue'
import ImportBatchProgress from '@/components/ImportBatchProgress.vue'
import ImportItemDetail from '@/components/ImportItemDetail.vue'
import ImportSelectionBatch from '@/components/ImportSelectionBatch.vue'
import { api, ApiError } from '@/lib/api'
import type { IApplyResult } from '@/lib/importApply'
import { fullTime, tokens } from '@/lib/format'
import {
  batchName,
  CATALOG_HINT,
  CATALOG_LABEL,
  citedBy,
  countByCatalog,
  countByKind,
  countByState,
  EMPTY_FILTERS,
  effectiveKind,
  filterItems,
  groupByKind,
  type IImportBatch,
  type IImportBatchView,
  type IImportFilters,
  type IImportItemStatus,
  type IImportJob,
  type IImportJobSummary,
  type IImportPlan,
  type IInventoryItem,
  type ISelectionPlan,
  ignoredDirs,
  itemTokens,
  KIND_LABEL,
  LINK_REASON_LABEL,
  noteCodes,
  overridesFrom,
  searchIndex,
  sortItems,
  STATE_HINT,
  STATE_LABEL,
  STATE_ORDER,
  type TCatalogState,
  type TImportItemState,
  type TImportSort,
  type TInventoryKind,
} from '@/lib/importer'
import { BUILD_KINDS, type TBuildKind } from '@/lib/builder'
import { BUILDABLE_STATES, buildLink, builderKindFor, draftingWithoutConversation, type IImportBuildStatus } from '@/lib/importDraft'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * O IMPORTADOR do projeto em uso (só admin): os TRABALHOS DE IMPORTAÇÃO do projeto (cada análise de um repositório,
 * salva) e o inventário do trabalho aberto — o que achou de recurso agêntico, com tamanho, citações, estado no catálogo,
 * o que não traduz e o estado de cada item. A pessoa exclui/inclui e reclassifica item a item; isso fica gravado no
 * trabalho, e analisar de novo reaproveita pela chave (a fonte que mudou depois da decisão aparece como "fonte mudou").
 *
 * DUAS ÁREAS no trabalho aberto, para não misturar explorar com importar:
 * - INVENTÁRIO: o resumo, os filtros, a lista e o detalhe. A pessoa SELECIONA itens (caixas, ou "todos do filtro") e a
 *   barra de baixo leva a seleção para a área de lotes ("Montar lote", com ou sem as dependências);
 * - LOTES: os lotes salvos do trabalho, com o progresso, e o lote aberto em PASSOS — Montar (a ordem, o que fica de
 *   fora, nome e prefixo), Preparar (cada item com o estado e a conversa do construtor; "preparar tudo") e Gravar (o
 *   plano do catálogo do lote: `ImportApply`, que só grava com o clique e uma caixa por ampliação).
 *
 * ⛔ Fora isso, nada aqui grava no catálogo nem dispara construtor. Só o trabalho mais novo de cada repositório muda; os
 * outros são registro.
 */
const PAGE = 100
const CATALOG_STATES: readonly TCatalogState[] = ['new', 'same-project', 'global', 'other-project']

const auth = useAuthStore()
const projects = useProjectsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))

const repositories = ref<string[]>([])
const repository = ref('')
const busy = ref(false)
const error = ref<string>()
/** Os trabalhos do projeto (mais novo primeiro) e o aberto. */
const jobs = ref<IImportJobSummary[]>([])
/** ⚖️ `shallowRef`: o inventário é grande (centenas de itens, milhares de fontes) e só é trocado inteiro. */
const job = shallowRef<IImportJob>()
const scan = computed(() => job.value?.scan)
/** O estado de cada item do trabalho aberto, pela chave (o que muda item a item). */
const statuses = ref<Record<string, IImportItemStatus>>({})
const readonly = computed(() => !!job.value && !job.value.latest)
const itemBusy = ref(false)
const itemError = ref<string>()
const filters = ref<IImportFilters>({ ...EMPTY_FILTERS })
const sort = ref<TImportSort>('kind')
const overrides = computed(() => overridesFrom(Object.values(statuses.value)))
const selectedKey = ref<string>()
const limit = ref(PAGE)
/** O lote do agente escolhido (só leitura) e o prefixo dos ids. */
const plan = shallowRef<IImportPlan>()
const prefix = ref('')
const planning = ref(false)
const planError = ref<string>()
/** A seleção do trabalho aberto (chaves) e o lote por seleção: a prévia, ou o lote salvo aberto. */
const picked = ref<Set<string>>(new Set())
const selectionPlan = shallowRef<ISelectionPlan>()
const openedBatch = shallowRef<IImportBatch>()
const previewName = ref('')
const batches = ref<IImportBatch[]>([])
const batchBusy = ref(false)
const batchError = ref<string>()
/** A área do trabalho aberto e o passo do lote aberto (ver o comentário do topo). */
const area = ref<'inventory' | 'batches'>('inventory')
type TStep = 'build' | 'prepare' | 'apply'
const step = ref<TStep>('build')
const STEPS: ReadonlyArray<{ id: TStep; label: string }> = [
  { id: 'build', label: 'Montar' },
  { id: 'prepare', label: 'Preparar' },
  { id: 'apply', label: 'Gravar' },
]
/** "Gravar todos os aprovados do trabalho" (fora de lote), aberto na área de lotes. */
const applyAll = ref(false)
/** O ignorar do projeto: um padrão por linha, como está salvo e como está no campo. */
const ignoreSaved = ref<string[]>([])
const ignoreText = ref('')
const ignoreBusy = ref(false)
const ignoreMessage = ref<string>()
const ignoreError = ref<string>()
const ignoreDirty = computed(() => parseIgnore(ignoreText.value).join('\n') !== ignoreSaved.value.join('\n'))

const items = computed(() => scan.value?.items ?? [])
const itemMap = computed(() => new Map(items.value.map((item) => [item.key, item])))
const index = computed(() => searchIndex(items.value))
const known = computed(() => new Set(items.value.map((item) => item.key)))
const citations = computed(() => citedBy(items.value))
const kinds = computed(() => countByKind(items.value, overrides.value))
const catalogCounts = computed(() => countByCatalog(items.value))
const codes = computed(() => noteCodes(items.value))
const untranslatableCount = computed(() => items.value.filter((item) => item.notes.some((note) => note.level === 'untranslatable')).length)
const attentionCount = computed(() => items.value.filter((item) => item.notes.some((note) => note.level === 'attention')).length)
const reclassifiedCount = computed(() => Object.keys(overrides.value).length)
const dirs = computed(() => ignoredDirs(scan.value?.ignored.dirs ?? {}))
const statusMap = computed(() => new Map(Object.entries(statuses.value)))
const stateCounts = computed(() => {
  const out: Partial<Record<TImportItemState, number>> = {}
  for (const entry of Object.values(statuses.value)) out[entry.state] = (out[entry.state] ?? 0) + 1
  return countByState(out)
})

const filtered = computed(() => sortItems(filterItems(items.value, filters.value, overrides.value, index.value, statusMap.value), sort.value, overrides.value))
const shown = computed(() => filtered.value.slice(0, limit.value))
const groups = computed(() => (sort.value === 'kind' ? groupByKind(shown.value, overrides.value) : [{ kind: undefined, items: shown.value }]))
const selected = computed(() => (selectedKey.value ? items.value.find((item) => item.key === selectedKey.value) : undefined))
const filtering = computed(() => !!(filters.value.kind || filters.value.catalog || filters.value.note || filters.value.state || filters.value.query.trim()))

watch([filters, sort], () => (limit.value = PAGE), { deep: true })
watch(selectedKey, () => (reviewError.value = undefined))

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const issues = (failure.details as Array<{ message?: string }>).map((item) => item.message).filter(Boolean)
    if (issues.length) return issues.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
}

// ── O construtor em modo importação ─────────────────────────────────────────

const router = inject(routerKey, null)
const building = ref(false)
const reviewError = ref<string>()
/**
 * O que vai ao construtor, agrupado por construtor (uma conversa por grupo): só os itens com construtor e sem conversa
 * nem rascunho em curso (pendente, rejeitado, com erro, com a fonte mudada).
 */
function builderGroups(keys: readonly string[]): Array<{ kind: TBuildKind; keys: string[] }> {
  if (readonly.value) return []
  const byKey = new Map(items.value.map((item) => [item.key, item]))
  const groups = new Map<TBuildKind, string[]>()
  for (const key of keys) {
    const item = byKey.get(key)
    const status = statuses.value[key] as IImportBuildStatus | undefined
    const state = status?.state ?? 'pending'
    if (!item || !BUILDABLE_STATES.includes(state) || state === 'review' || (state === 'drafting' && !draftingWithoutConversation(status))) continue
    const kind = builderKindFor(effectiveKind(item, overrides.value))
    if (kind) groups.set(kind, [...(groups.get(kind) ?? []), key])
  }
  return [...groups.entries()].map(([kind, list]) => ({ kind, keys: list }))
}
/** O lote salvo aberto, por construtor. */
const batchGroups = computed(() => (openedBatch.value ? builderGroups(openedBatch.value.order.length ? openedBatch.value.order : openedBatch.value.keys) : []))

/** Guarda o item que o servidor devolveu e recontá os estados do trabalho na lista. */
/** Gravar no catálogo: o alvo aberto (lote salvo, seleção ou todo o trabalho). */
const applyTarget = ref<{ batchId?: string; keys?: string[]; label: string }>()
const approvedCount = computed(() => Object.values(statuses.value).filter((entry) => entry.state === 'approved').length)

/** O progresso de um lote salvo: quantos já estão aprovados ou gravados, do total. */
function progressOf(batch: IImportBatch): { done: number; total: number } {
  const keys = batch.order.length ? batch.order : batch.keys
  return { done: keys.filter((key) => ['approved', 'applied'].includes(statuses.value[key]?.state ?? '')).length, total: keys.length }
}

/** O passo em que o lote está: falta ir ao construtor → Preparar; algo aprovado e nada mais a preparar → Gravar. */
function stepOf(batch: IImportBatch): TStep {
  const keys = batch.order.length ? batch.order : batch.keys
  if (builderGroups(keys).length) return 'prepare'
  return keys.some((key) => statuses.value[key]?.state === 'approved') ? 'apply' : 'prepare'
}

/**
 * Os estados de AGORA dos itens do lote (a pessoa revisou nas conversas, noutra tela): a rota leve do trabalho, em
 * pedaços de 200 chaves.
 */
async function refreshStates(keys: readonly string[]) {
  if (!project.value || !job.value || !keys.length) return
  try {
    for (let at = 0; at < keys.length; at += 200) {
      const found = await api<{ states: IImportItemStatus[] } | undefined>(`${projectPath()}/jobs/${encodeURIComponent(job.value.id)}/items`, { query: { keys: keys.slice(at, at + 200) } })
      for (const state of found?.states ?? []) keep(state)
    }
  } catch (failure) {
    batchError.value = message(failure)
  }
}

function goStep(next: TStep) {
  step.value = next
  if (next === 'prepare' && openedBatch.value) void refreshStates(openedBatch.value.order.length ? openedBatch.value.order : openedBatch.value.keys)
}

/** "Gravar todos os aprovados do trabalho": o plano de tudo o que está aprovado, fora de lote. */
function openApplyAll() {
  closeSelection()
  plan.value = undefined
  applyAll.value = true
  applyTarget.value = { label: 'todos os aprovados do trabalho' }
  area.value = 'batches'
}

/** Gravou: os itens gravados viram `applied`, com o lote. */
/** "Gravar junto": as faltas aprovadas entram na seleção, e a gravação é refeita com elas. */
function includeInApply(keys: string[]) {
  // Na migração salva, a falta aprovada entra NELA (e a gravação é refeita com ela).
  if (openedBatch.value && step.value === 'apply') return void addToBatch(openedBatch.value.id, keys, false, true)
  if (!applyTarget.value?.keys) return
  const next = [...new Set([...applyTarget.value.keys, ...keys])]
  picked.value = new Set([...picked.value, ...keys])
  applyTarget.value = { keys: next, label: `${next.length} selecionado(s)` }
}

function applied(result: IApplyResult) {
  for (const key of result.items.applied) {
    const current = statuses.value[key]
    if (current) keep({ ...current, state: 'applied', ...(result.batch ? { batchId: result.batch.id } : {}) })
  }
}

function keep(updated: IImportItemStatus) {
  statuses.value = { ...statuses.value, [updated.key]: updated }
  const counts: Partial<Record<TImportItemState, number>> = {}
  for (const entry of Object.values(statuses.value)) counts[entry.state] = (counts[entry.state] ?? 0) + 1
  jobs.value = jobs.value.map((entry) => (entry.id === job.value!.id ? { ...entry, byState: counts } : entry))
}

/**
 * "Importar com o construtor": abre UMA conversa com o construtor do tipo (em modo importação) para os itens, e vai até
 * ela. A pessoa conversa normalmente; os rascunhos voltam para a revisão aqui.
 */
async function openBuilder(target: { keys?: string[]; batchId?: string; kind?: TBuildKind }) {
  if (!project.value || !job.value || readonly.value) return
  building.value = true
  reviewError.value = undefined
  try {
    const opened = await api<{ conversationId: string; kind: Parameters<typeof buildLink>[0]; keys: string[] }>(`${projectPath()}/jobs/${encodeURIComponent(job.value.id)}/builder`, {
      method: 'POST',
      body: target,
    })
    for (const key of opened.keys) keep({ ...(statuses.value[key] ?? { key, fingerprint: '' }), key, state: 'drafting', conversationId: opened.conversationId } as IImportItemStatus)
    // Vai até a conversa (a guia Construir do tipo, com ela aberta).
    if (router) await router.push(buildLink(opened.kind, opened.conversationId))
  } catch (failure) {
    reviewError.value = message(failure)
  } finally {
    building.value = false
  }
}

/** Aprovar (com o OK de cada remoção) ou pedir ajuste (com o comentário para a conversa). ⛔ Nada vai ao catálogo. */
async function reviewItem(key: string, action: 'approve' | 'adjust', body: { removals?: number[]; comment?: string }) {
  if (!project.value || !job.value || readonly.value) return
  itemBusy.value = true
  reviewError.value = undefined
  try {
    keep(await api<IImportItemStatus>(`${projectPath()}/jobs/${encodeURIComponent(job.value.id)}/items/${action}`, { method: 'POST', body: { key, ...body } }))
  } catch (failure) {
    reviewError.value = message(failure)
  } finally {
    itemBusy.value = false
  }
}

function parseIgnore(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))]
}

async function loadIgnore() {
  ignoreSaved.value = []
  ignoreText.value = ''
  ignoreMessage.value = undefined
  ignoreError.value = undefined
  if (!project.value) return
  try {
    const result = await api<{ patterns: string[] }>(`/projects/${encodeURIComponent(project.value.id)}/import/ignore`)
    ignoreSaved.value = result.patterns
    ignoreText.value = result.patterns.join('\n')
  } catch (failure) {
    ignoreError.value = message(failure)
  }
}

async function saveIgnore() {
  if (!project.value) return
  ignoreBusy.value = true
  ignoreMessage.value = undefined
  ignoreError.value = undefined
  try {
    const result = await api<{ patterns: string[] }>(`/projects/${encodeURIComponent(project.value.id)}/import/ignore`, { method: 'PUT', body: { patterns: parseIgnore(ignoreText.value) } })
    ignoreSaved.value = result.patterns
    ignoreText.value = result.patterns.join('\n')
    ignoreMessage.value = scan.value ? 'Salvo. Analise de novo para aplicar.' : 'Salvo.'
  } catch (failure) {
    ignoreError.value = message(failure)
  } finally {
    ignoreBusy.value = false
  }
}

async function buildPlan(agent: string, nextPrefix = prefix.value) {
  if (!project.value || !scan.value) return
  planning.value = true
  planError.value = undefined
  try {
    const body = { repository: scan.value.repository, agent, ...(nextPrefix ? { prefix: nextPrefix } : {}), ...(job.value ? { job: job.value.id } : {}) }
    plan.value = await api<IImportPlan>(`/projects/${encodeURIComponent(project.value.id)}/import/plan`, { method: 'POST', body })
    prefix.value = plan.value.prefix
    closeSelection()
    applyAll.value = false
    area.value = 'batches'
  } catch (failure) {
    planError.value = message(failure)
  } finally {
    planning.value = false
  }
}

function projectPath(): string {
  return `/projects/${encodeURIComponent(project.value!.id)}/import`
}

function batchesPath(): string {
  return `${projectPath()}/jobs/${encodeURIComponent(job.value!.id)}/batches`
}

function togglePick(key: string) {
  const next = new Set(picked.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  picked.value = next
}

/** Seleciona todos os itens do filtro atual (não só a página que aparece), somando à seleção. */
function pickFiltered() {
  const next = new Set(picked.value)
  for (const item of filtered.value) next.add(item.key)
  picked.value = next
}

function clearPicked() {
  picked.value = new Set()
}

async function loadBatches() {
  if (!project.value || !job.value) return
  try {
    batches.value = await api<IImportBatch[]>(batchesPath())
  } catch (failure) {
    batchError.value = message(failure)
  }
}

/**
 * A prévia do lote: as chaves escolhidas (na ordem da lista) e o prefixo. `closure`: cada chave com as dependências (o
 * servidor devolve o lote com todas). Não salva nada.
 */
async function buildSelection(keys = items.value.filter((item) => picked.value.has(item.key)).map((item) => item.key), nextPrefix = selectionPlan.value?.prefix ?? '', closure = false) {
  if (!project.value || !job.value || !keys.length) return
  const fresh = closure || !selectionPlan.value || !!openedBatch.value || keys.join('\n') !== selectionPlan.value.keys.join('\n')
  batchBusy.value = true
  batchError.value = undefined
  prepared.value = undefined
  applyAll.value = false
  plan.value = undefined
  area.value = 'batches'
  step.value = 'build'
  try {
    selectionPlan.value = await api<ISelectionPlan>(`${batchesPath()}/plan`, { method: 'POST', body: { keys, ...(nextPrefix ? { prefix: nextPrefix } : {}), ...(closure ? { closure } : {}) } })
    if (closure && keys.length === 1) previewName.value = `${keys[0].slice(keys[0].indexOf(':') + 1)} e dependências`
    else if (fresh) previewName.value = batchName(items.value.filter((item) => keys.includes(item.key)), overrides.value)
    openedBatch.value = undefined
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** Salva a prévia como lote do trabalho (nome, itens, ordem). ⛔ Não dispara nada nem grava no catálogo. */
async function saveBatch(name: string) {
  if (!project.value || !job.value || !selectionPlan.value || readonly.value) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const plan = selectionPlan.value
    const view = await api<IImportBatchView>(batchesPath(), { method: 'POST', body: { name, keys: plan.keys, ...(plan.prefix ? { prefix: plan.prefix } : {}) } })
    const { plan: batchPlan, ...record } = view
    openedBatch.value = record
    selectionPlan.value = batchPlan
    batches.value = [record, ...batches.value.filter((entry) => entry.id !== record.id)]
    step.value = 'prepare'
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** As conversas que o "preparar tudo" abriu (uma por construtor), com o link de cada uma. */
const prepared = ref<Array<{ kind: TBuildKind; conversationId: string; keys: string[] }>>()

/** PREPARAR TUDO: o lote salvo vai ao construtor de uma vez, uma conversa por construtor. ⛔ Não grava no catálogo. */
async function prepareBatch(batchId: string) {
  if (!project.value || !job.value || readonly.value) return
  building.value = true
  batchError.value = undefined
  try {
    const result = await api<{ conversations: Array<{ kind: TBuildKind; conversationId: string; keys: string[] }> }>(`${batchesPath()}/${encodeURIComponent(batchId)}/prepare`, {
      method: 'POST',
    })
    for (const opened of result.conversations)
      for (const key of opened.keys) keep({ ...(statuses.value[key] ?? { key, fingerprint: '' }), key, state: 'drafting', conversationId: opened.conversationId } as IImportItemStatus)
    prepared.value = result.conversations
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    building.value = false
  }
}

/** "Preparar com as dependências" (no detalhe do item): o lote com o fecho, na área de lotes. */
async function withDependencies(key: string) {
  await buildSelection([key], '', true)
}

/** Acrescenta itens a uma migração salva (com as dependências, se pedido) e a abre com o estado de agora. */
async function addToBatch(batchId: string, keys: readonly string[], closure = false, keepStep = false) {
  if (!project.value || !job.value || readonly.value || !keys.length) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const view = await api<IImportBatchView>(`${batchesPath()}/${encodeURIComponent(batchId)}/items`, { method: 'POST', body: { keys, ...(closure ? { closure } : {}) } })
    const { plan: batchPlan, ...record } = view
    openedBatch.value = record
    selectionPlan.value = batchPlan
    batches.value = batches.value.map((entry) => (entry.id === record.id ? record : entry))
    applyAll.value = false
    plan.value = undefined
    area.value = 'batches'
    if (!keepStep) step.value = stepOf(record)
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** A migração salva que recebe a seleção do inventário ("Adicionar à migração"). */
const addTarget = ref('')

/** "Salvar e preparar tudo": salva a prévia como lote e já abre as conversas. */
async function saveAndPrepare(name: string) {
  await saveBatch(name)
  if (openedBatch.value && !batchError.value) await prepareBatch(openedBatch.value.id)
}

async function openBatch(id: string) {
  if (!project.value || !job.value) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const view = await api<IImportBatchView>(`${batchesPath()}/${encodeURIComponent(id)}`)
    const { plan: batchPlan, ...record } = view
    applyAll.value = false
    applyTarget.value = undefined
    plan.value = undefined
    prepared.value = undefined
    openedBatch.value = record
    selectionPlan.value = batchPlan
    area.value = 'batches'
    await refreshStates(record.order.length ? record.order : record.keys)
    step.value = stepOf(record)
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

function closeSelection() {
  prepared.value = undefined
  selectionPlan.value = undefined
  openedBatch.value = undefined
  batchError.value = undefined
}

async function loadJobs() {
  if (!project.value) return
  try {
    jobs.value = await api<IImportJobSummary[]>(`${projectPath()}/jobs`)
  } catch (failure) {
    error.value = message(failure)
  }
}

/** Abre o trabalho que veio da API: o inventário, os estados e a tela limpa. */
function show(opened: IImportJob) {
  job.value = opened
  statuses.value = Object.fromEntries(opened.states.map((entry) => [entry.key, entry]))
  repository.value = opened.repository
  selectedKey.value = undefined
  plan.value = undefined
  planError.value = undefined
  itemError.value = undefined
  filters.value = { ...EMPTY_FILTERS }
  limit.value = PAGE
  picked.value = new Set()
  batches.value = []
  applyTarget.value = undefined
  applyAll.value = false
  area.value = 'inventory'
  closeSelection()
  void loadBatches()
}

async function openJob(id: string) {
  if (!project.value) return
  busy.value = true
  error.value = undefined
  try {
    show(await api<IImportJob>(`${projectPath()}/jobs/${encodeURIComponent(id)}`))
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

/** Muda um item do trabalho aberto (excluir/incluir, reclassificar) e guarda o que o servidor devolveu. */
async function changeItem(key: string, change: { state?: 'pending' | 'skipped'; kind?: TInventoryKind | null }) {
  if (!project.value || !job.value || readonly.value) return
  itemBusy.value = true
  itemError.value = undefined
  try {
    const updated = await api<IImportItemStatus>(`${projectPath()}/jobs/${encodeURIComponent(job.value.id)}/items`, { method: 'PATCH', body: { key, ...change } })
    statuses.value = { ...statuses.value, [key]: updated }
    const counts: Partial<Record<TImportItemState, number>> = {}
    for (const entry of Object.values(statuses.value)) counts[entry.state] = (counts[entry.state] ?? 0) + 1
    jobs.value = jobs.value.map((entry) => (entry.id === job.value!.id ? { ...entry, byState: counts } : entry))
  } catch (failure) {
    itemError.value = message(failure)
  } finally {
    itemBusy.value = false
  }
}

async function loadRepositories() {
  repositories.value = []
  repository.value = ''
  jobs.value = []
  if (!project.value) return
  void loadIgnore()
  void loadJobs()
  try {
    const list = await api<Array<{ name: string }>>(`/projects/${encodeURIComponent(project.value.id)}/repositories`)
    repositories.value = list.map((item) => item.name)
    repository.value = repositories.value[0] ?? ''
  } catch (failure) {
    error.value = message(failure)
  }
}

async function analyze() {
  if (!project.value || !repository.value) return
  busy.value = true
  error.value = undefined
  try {
    show(await api<IImportJob>(`${projectPath()}/jobs`, { method: 'POST', body: { repository: repository.value } }))
    await loadJobs()
  } catch (failure) {
    error.value = message(failure)
  } finally {
    busy.value = false
  }
}

function reset() {
  job.value = undefined
  jobs.value = []
  statuses.value = {}
  plan.value = undefined
  planError.value = undefined
  itemError.value = undefined
  selectedKey.value = undefined
  filters.value = { ...EMPTY_FILTERS }
  error.value = undefined
  picked.value = new Set()
  batches.value = []
  closeSelection()
}

function reclassify(key: string, kind: TInventoryKind | undefined) {
  void changeItem(key, { kind: kind ?? null })
}

function stateOf(item: IInventoryItem): TImportItemState {
  return statuses.value[item.key]?.state ?? 'pending'
}

function reuseText(entry: IImportJobSummary): string | undefined {
  const reuse = entry.reuse
  if (!reuse) return undefined
  const parts = [`${reuse.kept} mantido(s)`]
  if (reuse.stale.length) parts.push(`${reuse.stale.length} com fonte mudada`)
  if (reuse.restored.length) parts.push(`${reuse.restored.length} com a fonte de volta`)
  if (reuse.added.length) parts.push(`${reuse.added.length} novo(s)`)
  if (reuse.gone.length) parts.push(`${reuse.gone.length} sumiram`)
  return parts.join(' · ')
}

function toggleKind(kind: TInventoryKind) {
  filters.value = { ...filters.value, kind: filters.value.kind === kind ? '' : kind }
}

function toggleCatalog(state: TCatalogState) {
  filters.value = { ...filters.value, catalog: filters.value.catalog === state ? '' : state }
}

function noteBadges(item: IInventoryItem): { untranslatable: number; attention: number; broken: boolean } {
  let untranslatable = 0
  let attention = 0
  for (const note of item.notes) {
    if (note.level === 'untranslatable') untranslatable += 1
    else if (note.level === 'attention') attention += 1
  }
  return { untranslatable, attention, broken: item.unresolved.length > 0 }
}

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await loadRepositories()
})
watch(
  () => projects.current,
  () => {
    reset()
    if (auth.isAdmin) void loadRepositories()
  },
)
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra usa o importador do projeto.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-6xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Importador{{ project ? ` — ${project.name}` : '' }}</h1>
        <p class="text-xs text-zinc-500">
          O que um repositório do projeto tem de agentes, skills, commands, rules e docs, e como isso chegaria ao catálogo. Cada análise fica salva como um trabalho de importação, com o
          que você decidir item a item. Nada vai ao catálogo.
        </p>
      </header>

      <p v-if="!project" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Escolha um projeto no seletor do topo.</p>
      <template v-else>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="analyze">
          <label class="field min-w-48 flex-1 sm:max-w-xs">
            Repositório
            <select v-model="repository" class="input" :disabled="busy || !repositories.length" data-test="repository">
              <option v-for="name in repositories" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <button type="submit" class="btn btn-primary" :disabled="busy || !repository" data-test="analyze">{{ busy ? 'Analisando…' : scan ? 'Analisar de novo' : 'Analisar' }}</button>
        </form>
        <p v-if="!repositories.length && !error" class="text-xs text-zinc-500">Este projeto não tem repositório (pasta <code>repositories/</code> com git).</p>
        <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

        <section v-if="jobs.length" class="flex flex-col gap-1.5" data-test="jobs">
          <h2 class="text-xs font-medium text-zinc-500">Trabalhos de importação ({{ jobs.length }})</h2>
          <ul class="scroll-thin flex max-h-56 flex-col divide-y divide-zinc-800 overflow-y-auto rounded-xl border border-zinc-800">
            <li v-for="entry in jobs" :key="entry.id">
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-zinc-900"
                :class="entry.id === job?.id ? 'bg-zinc-900' : ''"
                data-test="job"
                @click="openJob(entry.id)"
              >
                <span class="font-medium text-zinc-200">{{ entry.repository }}</span>
                <span class="text-zinc-400">{{ fullTime(entry.scannedAt) }}</span>
                <code v-if="entry.head" class="text-zinc-500" :title="entry.head">{{ entry.head.slice(0, 12) }}</code>
                <span class="text-zinc-500">por {{ entry.by }}</span>
                <span class="text-zinc-500">{{ entry.items }} itens</span>
                <span v-for="count in countByState(entry.byState)" :key="count.state" class="rounded-full bg-zinc-800 px-2 text-[11px]" :class="count.state === 'stale' ? 'text-amber-200' : 'text-zinc-300'">
                  {{ STATE_LABEL[count.state] }} {{ count.count }}
                </span>
                <span v-if="entry.latest" class="rounded-full border border-emerald-500/40 px-2 text-[11px] text-emerald-200">mais novo</span>
                <span v-else class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-500" title="Há análise mais nova deste repositório: este fica como registro">registro</span>
              </button>
            </li>
          </ul>
        </section>

        <details class="rounded-xl border border-zinc-800 px-3 py-2 text-xs" data-test="ignore-editor">
          <summary class="cursor-pointer text-zinc-400">Ignorar neste projeto ({{ ignoreSaved.length }} padrão(ões))</summary>
          <form class="mt-2 flex flex-col gap-2" @submit.prevent="saveIgnore">
            <label class="field">
              Um padrão por linha, como no .gitignore: sem <code>/</code> casa o nome em qualquer pasta; com <code>/</code>, a partir da raiz do repositório.
              <textarea v-model="ignoreText" class="input min-h-24 font-mono" rows="4" placeholder=".agents/benchmark/results&#10;*.log" data-test="ignore-patterns" />
            </label>
            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" class="btn btn-secondary btn-sm" :disabled="ignoreBusy || !ignoreDirty" data-test="ignore-save">{{ ignoreBusy ? 'Salvando…' : 'Salvar padrões' }}</button>
              <span v-if="ignoreMessage" class="text-emerald-300">{{ ignoreMessage }}</span>
              <span v-if="ignoreError" class="text-rose-300" data-test="ignore-error">{{ ignoreError }}</span>
            </div>
          </form>
        </details>

        <template v-if="scan">
          <nav class="flex gap-1 border-b border-zinc-800" role="tablist" data-test="areas">
            <button type="button" role="tab" class="area-tab" :aria-selected="area === 'inventory'" :class="area === 'inventory' ? 'on' : ''" data-test="area-inventory" @click="area = 'inventory'">
              Inventário
            </button>
            <button type="button" role="tab" class="area-tab" :aria-selected="area === 'batches'" :class="area === 'batches' ? 'on' : ''" data-test="area-batches" @click="area = 'batches'">
              Migrações <span class="text-zinc-500">{{ batches.length }}</span>
            </button>
          </nav>

          <template v-if="area === 'inventory'">
            <section class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3" data-test="summary">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                <span class="font-medium text-zinc-200">{{ scan.repository }}</span>
                <span v-if="scan.head" :title="scan.head">HEAD <code class="text-zinc-300">{{ scan.head.slice(0, 12) }}</code></span>
                <span v-else>sem HEAD</span>
                <span v-if="scan.dirty" class="rounded-full border border-amber-500/40 px-2 text-[11px] text-amber-200" title="Há mudança não commitada: a análise lê o que está no disco">árvore suja</span>
                <span v-else-if="scan.dirty === false" class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400">árvore limpa</span>
                <span>analisado em {{ fullTime(scan.scannedAt) }}<template v-if="job"> por {{ job.by }}</template></span>
              </div>
              <p v-if="job && reuseText(job)" class="text-xs text-zinc-400" data-test="reuse">Reaproveitado da análise anterior: {{ reuseText(job) }}</p>
              <p v-if="readonly" class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-100" data-test="readonly">
                Há análise mais nova deste repositório: este trabalho é registro e não muda. Abra o mais novo para excluir, incluir ou reclassificar.
              </p>
              <div class="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                Formatos:
                <code v-for="format in scan.formats" :key="format" class="rounded bg-zinc-900 px-1.5 text-zinc-200">{{ format }}</code>
                <span v-if="!scan.formats.length">nenhum reconhecido</span>
              </div>
              <p class="text-sm text-zinc-300">
                <strong>{{ scan.totals.items.toLocaleString('pt-BR') }}</strong> itens · <strong>{{ scan.totals.files.toLocaleString('pt-BR') }}</strong> arquivos · ≈<strong>{{ tokens(scan.totals.tokens) }}</strong> tokens
                <template v-if="reclassifiedCount"> · {{ reclassifiedCount }} reclassificado(s)</template>
              </p>
              <div class="flex flex-wrap gap-1.5" data-test="states">
                <button
                  v-for="entry in stateCounts"
                  :key="entry.state"
                  type="button"
                  class="chip"
                  :class="[{ on: filters.state === entry.state }, entry.state === 'stale' ? 'border-amber-500/50 text-amber-200' : '']"
                  :title="STATE_HINT[entry.state]"
                  @click="filters = { ...filters, state: filters.state === entry.state ? '' : entry.state }"
                >
                  {{ STATE_LABEL[entry.state] }} <span class="text-zinc-500">{{ entry.count }}</span>
                </button>
              </div>
              <div class="flex flex-wrap gap-1.5" data-test="kinds">
                <button v-for="entry in kinds" :key="entry.kind" type="button" class="chip" :class="{ on: filters.kind === entry.kind }" @click="toggleKind(entry.kind)">
                  {{ KIND_LABEL[entry.kind] }} <span class="text-zinc-500">{{ entry.count }}</span>
                </button>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="state in CATALOG_STATES"
                  :key="state"
                  type="button"
                  class="chip"
                  :class="[{ on: filters.catalog === state }, state === 'other-project' && catalogCounts[state] ? 'border-rose-500/50 text-rose-200' : '']"
                  :title="CATALOG_HINT[state]"
                  @click="toggleCatalog(state)"
                >
                  {{ CATALOG_LABEL[state] }} <span class="text-zinc-500">{{ catalogCounts[state] }}</span>
                </button>
                <button v-if="untranslatableCount" type="button" class="chip border-amber-500/40 text-amber-200" :class="{ on: filters.note === 'untranslatable' }" @click="filters = { ...filters, note: filters.note === 'untranslatable' ? '' : 'untranslatable' }">
                  não traduz <span class="text-zinc-500">{{ untranslatableCount }}</span>
                </button>
              </div>
              <div class="flex flex-col gap-1 text-xs text-zinc-500">
                <details v-if="dirs.length">
                  <summary class="cursor-pointer text-zinc-400">Pastas ignoradas ({{ dirs.length }})</summary>
                  <p class="mt-1 flex flex-wrap gap-x-3">
                    <span v-for="dir in dirs" :key="dir.name"><code class="text-zinc-300">{{ dir.name }}</code> ×{{ dir.count }}</span>
                  </p>
                </details>
                <details v-if="scan.ignored.binaries.length">
                  <summary class="cursor-pointer text-zinc-400">Binários pulados ({{ scan.ignored.binaries.length }})</summary>
                  <ul class="mt-1">
                    <li v-for="path in scan.ignored.binaries" :key="path"><code class="break-all">{{ path }}</code></li>
                  </ul>
                </details>
                <details v-if="scan.ignored.links.length" data-test="links">
                  <summary class="cursor-pointer" :class="scan.ignored.links.some((link) => link.reason === 'outside') ? 'text-amber-200' : 'text-zinc-400'">Links recusados ({{ scan.ignored.links.length }})</summary>
                  <ul class="mt-1">
                    <li v-for="link in scan.ignored.links" :key="link.path">
                      <code class="break-all text-zinc-300">{{ link.path }}</code> — {{ LINK_REASON_LABEL[link.reason] }}
                    </li>
                  </ul>
                </details>
                <span v-if="!dirs.length && !scan.ignored.binaries.length && !scan.ignored.links.length">Nada ignorado.</span>
              </div>
            </section>

            <section class="flex flex-wrap items-end gap-2" data-test="filters">
              <label class="field min-w-48 flex-[2]">
                Buscar
                <input v-model="filters.query" class="input" type="search" placeholder="id ou caminho" data-test="query" />
              </label>
              <label class="field min-w-36 flex-1">
                Tipo
                <select v-model="filters.kind" class="input" data-test="kind">
                  <option value="">Todos</option>
                  <option v-for="entry in kinds" :key="entry.kind" :value="entry.kind">{{ KIND_LABEL[entry.kind] }} ({{ entry.count }})</option>
                </select>
              </label>
              <label class="field min-w-36 flex-1">
                No catálogo
                <select v-model="filters.catalog" class="input" data-test="catalog">
                  <option value="">Qualquer</option>
                  <option v-for="state in CATALOG_STATES" :key="state" :value="state">{{ CATALOG_LABEL[state] }} ({{ catalogCounts[state] }})</option>
                  <option value="none">fora do catálogo ({{ catalogCounts.none }})</option>
                </select>
              </label>
              <label class="field min-w-44 flex-1">
                Notas
                <select v-model="filters.note" class="input" data-test="note">
                  <option value="">Todas</option>
                  <option value="attention">com alerta ({{ attentionCount }})</option>
                  <option value="untranslatable">não traduz ({{ untranslatableCount }})</option>
                  <option v-for="entry in codes" :key="entry.code" :value="`code:${entry.code}`">{{ entry.code }} ({{ entry.count }})</option>
                </select>
              </label>
              <label class="field min-w-36 flex-1">
                Estado
                <select v-model="filters.state" class="input" data-test="state">
                  <option value="">Todos</option>
                  <option v-for="state in STATE_ORDER" :key="state" :value="state">{{ STATE_LABEL[state] }}</option>
                </select>
              </label>
              <label class="field min-w-32 flex-1">
                Ordem
                <select v-model="sort" class="input">
                  <option value="kind">por tipo</option>
                  <option value="key">por chave</option>
                  <option value="tokens">mais tokens</option>
                </select>
              </label>
              <button v-if="filtering" type="button" class="btn btn-ghost btn-sm mb-1" @click="filters = { ...EMPTY_FILTERS }">Limpar</button>
            </section>

            <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
              <section class="flex min-w-0 flex-col gap-2">
                <p class="text-xs text-zinc-500" data-test="count">{{ filtered.length.toLocaleString('pt-BR') }} de {{ items.length.toLocaleString('pt-BR') }} itens</p>
                <p v-if="reviewError && !selected" class="text-xs text-rose-300" data-test="build-error">{{ reviewError }}</p>
                <p v-if="!filtered.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Nenhum item com estes filtros.</p>
                <div v-for="group in groups" :key="group.kind ?? 'all'" class="flex flex-col gap-1">
                  <h2 v-if="group.kind" class="sticky top-0 z-10 bg-zinc-950/95 py-1 text-xs font-semibold text-zinc-400">{{ KIND_LABEL[group.kind] }} · {{ group.items.length }}</h2>
                  <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
                    <li v-for="item in group.items" :key="item.key" class="flex items-stretch" :class="picked.has(item.key) ? 'bg-sky-500/5' : ''">
                      <label class="flex shrink-0 cursor-pointer items-start pt-2.5 pl-3" :title="picked.has(item.key) ? 'Tirar da seleção' : 'Pôr na seleção'">
                        <input type="checkbox" class="accent-sky-500" :checked="picked.has(item.key)" :aria-label="`Selecionar ${item.key}`" data-test="pick" @change="togglePick(item.key)" />
                      </label>
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left hover:bg-zinc-900"
                        :class="item.key === selectedKey ? 'bg-zinc-900' : ''"
                        data-test="row"
                        @click="selectedKey = item.key"
                      >
                        <span class="flex flex-wrap items-center gap-2">
                          <span
                            v-if="stateOf(item) !== 'pending'"
                            class="rounded-full px-2 text-[11px]"
                            :class="stateOf(item) === 'stale' ? 'bg-amber-500/15 text-amber-200' : stateOf(item) === 'skipped' ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-800 text-zinc-300'"
                            :title="STATE_HINT[stateOf(item)]"
                            data-test="row-state"
                            >{{ STATE_LABEL[stateOf(item)] }}</span
                          >
                          <span class="rounded-full border px-2 text-[11px]" :class="overrides[item.key] ? 'border-emerald-500/50 text-emerald-200' : 'border-zinc-700 text-zinc-400'" :title="overrides[item.key] ? `Reclassificado (detectado: ${KIND_LABEL[item.kind]})` : undefined">{{
                            KIND_LABEL[effectiveKind(item, overrides)]
                          }}</span>
                          <span class="min-w-0 font-mono text-sm break-all text-zinc-100">{{ item.candidateId }}</span>
                          <span v-if="item.catalog && item.catalog !== 'new'" class="rounded-full border px-2 text-[11px]" :class="item.catalog === 'other-project' ? 'border-rose-500/50 text-rose-200' : 'border-zinc-700 text-zinc-400'">{{ CATALOG_LABEL[item.catalog] }}</span>
                          <span v-if="noteBadges(item).untranslatable" class="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-200">não traduz</span>
                          <span v-if="noteBadges(item).broken" class="rounded-full bg-rose-500/15 px-2 text-[11px] text-rose-200">ref. quebrada</span>
                          <span v-else-if="noteBadges(item).attention" class="rounded-full bg-zinc-800 px-2 text-[11px] text-amber-200">{{ noteBadges(item).attention }} alerta(s)</span>
                        </span>
                        <span class="truncate text-xs text-zinc-500">
                          {{ item.sources[0]?.path ?? item.key }}<template v-if="item.sources.length > 1"> +{{ item.sources.length - 1 }}</template> · ≈{{ tokens(itemTokens(item)) }} tokens
                        </span>
                      </button>
                    </li>
                  </ul>
                </div>
                <button v-if="filtered.length > shown.length" type="button" class="btn btn-secondary btn-sm self-center" data-test="more" @click="limit += PAGE">
                  Mostrar mais ({{ (filtered.length - shown.length).toLocaleString('pt-BR') }} restantes)
                </button>
              </section>

              <aside
                v-if="selected"
                class="scroll-thin max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:overflow-y-auto max-lg:bg-zinc-950 max-lg:px-4 max-lg:py-5 lg:sticky lg:top-0 lg:max-h-[calc(100vh-2.5rem)] lg:overflow-y-auto lg:rounded-xl lg:border lg:border-zinc-800 lg:p-3"
              >
                <ImportItemDetail
                  :item="selected"
                  :kind="effectiveKind(selected, overrides)"
                  :cited-by="citations.get(selected.key) ?? []"
                  :known="known"
                  :status="statuses[selected.key]"
                  :readonly="readonly"
                  :busy="itemBusy"
                  :error="itemError"
                  :planning="planning"
                  :building="building"
                  :review-error="reviewError"
                  @build="openBuilder({ keys: [selected.key] })"
                  @approve="reviewItem(selected.key, 'approve', { removals: $event })"
                  @adjust="reviewItem(selected.key, 'adjust', { comment: $event })"
                  @plan="buildPlan(selected.key)"
                  @closure="withDependencies(selected.key)"
                  @select="selectedKey = $event"
                  @reclassify="reclassify(selected.key, $event)"
                  @state="changeItem(selected.key, { state: $event })"
                  @close="selectedKey = undefined"
                />
              </aside>
              <p v-else class="hidden rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500 lg:block">Escolha um item para ver as fontes, as citações e as notas.</p>
            </div>

            <!-- A seleção: uma barra fixa embaixo, só com o que leva ao lote. -->
            <section
              v-if="items.length"
              class="sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-950/95 px-4 py-2 text-xs backdrop-blur"
              data-test="selection"
            >
              <span class="font-medium text-zinc-200" data-test="picked-count">{{ picked.size.toLocaleString('pt-BR') }} selecionado(s)</span>
              <button type="button" class="btn btn-ghost btn-sm" :disabled="!filtered.length" data-test="pick-filtered" @click="pickFiltered">
                Selecionar os {{ filtered.length.toLocaleString('pt-BR') }} do filtro
              </button>
              <button v-if="picked.size" type="button" class="btn btn-ghost btn-sm" data-test="pick-clear" @click="clearPicked">Limpar seleção</button>
              <span class="flex-1" />
              <template v-if="batches.length && !readonly">
                <select v-model="addTarget" class="input py-1 text-xs" aria-label="Migração que recebe a seleção" data-test="add-target">
                  <option value="" disabled>Adicionar a uma migração…</option>
                  <option v-for="entry in batches" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                </select>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  :disabled="!picked.size || !addTarget || batchBusy"
                  data-test="add-to-batch"
                  @click="addToBatch(addTarget, items.filter((item) => picked.has(item.key)).map((item) => item.key), true)"
                >
                  Adicionar (com dependências)
                </button>
              </template>
              <button type="button" class="btn btn-secondary btn-sm" :disabled="!picked.size || batchBusy" data-test="build-batch-closure" @click="buildSelection(undefined, '', true)">
                Migrar com dependências
              </button>
              <button type="button" class="btn btn-primary btn-sm" :disabled="!picked.size || batchBusy" data-test="build-batch" @click="buildSelection()">
                {{ batchBusy ? 'Montando…' : 'Migrar selecionados' }}
              </button>
            </section>
          </template>

          <section v-else class="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]" data-test="batches-area">
            <aside class="flex flex-col gap-2">
              <button type="button" class="btn btn-secondary btn-sm" data-test="new-batch" @click="area = 'inventory'">+ Nova migração (selecione no inventário)</button>
              <button
                v-if="selectionPlan && !openedBatch"
                type="button"
                class="rounded-xl border border-sky-500/40 bg-sky-500/5 px-3 py-2 text-left text-xs"
                data-test="draft-entry"
                @click="applyAll = false; plan = undefined"
              >
                <span class="block font-medium text-sky-200">Rascunho (não salvo)</span>
                <span class="text-zinc-400">{{ selectionPlan.keys.length }} item(ns)</span>
              </button>
              <p v-if="!batches.length" class="text-xs text-zinc-500">Nenhuma migração salva ainda.</p>
              <ul v-else class="flex flex-col gap-1" data-test="batches">
                <li v-for="entry in batches" :key="entry.id">
                  <button
                    type="button"
                    class="flex w-full flex-col gap-1 rounded-xl border px-3 py-2 text-left text-xs hover:bg-zinc-900"
                    :class="entry.id === openedBatch?.id ? 'border-emerald-500/50 bg-zinc-900' : 'border-zinc-800'"
                    data-test="batch-entry"
                    @click="openBatch(entry.id)"
                  >
                    <span class="font-medium text-zinc-200">{{ entry.name }}</span>
                    <span class="text-zinc-500">{{ progressOf(entry).done }}/{{ progressOf(entry).total }} aprovado(s) ou gravado(s)</span>
                    <span class="h-1 overflow-hidden rounded-full bg-zinc-800">
                      <span class="block h-full bg-emerald-500" :style="{ width: `${progressOf(entry).total ? (100 * progressOf(entry).done) / progressOf(entry).total : 0}%` }" />
                    </span>
                  </button>
                </li>
              </ul>
              <button v-if="!readonly && approvedCount" type="button" class="btn btn-ghost btn-sm justify-start" data-test="apply-all" @click="openApplyAll">
                Gravar todos os aprovados do trabalho ({{ approvedCount }})
              </button>
            </aside>

            <div class="flex min-w-0 flex-col gap-3">
              <p v-if="batchError" class="text-sm text-rose-300" data-test="selection-error">Migração: {{ batchError }}</p>
              <p v-if="planError" class="text-sm text-rose-300" data-test="plan-error">Migração: {{ planError }}</p>
              <p v-if="reviewError" class="text-xs text-rose-300" data-test="build-error">{{ reviewError }}</p>

              <ImportApply
                v-if="applyAll && applyTarget && job && project"
                :key="JSON.stringify(applyTarget)"
                :project-id="project.id"
                :job-id="job.id"
                :target="applyTarget"
                :readonly="readonly"
                @close="applyAll = false; applyTarget = undefined"
                @applied="applied"
                @select="(key) => { selectedKey = key; area = 'inventory' }"
                @build="openBuilder({ keys: $event })"
                @include="includeInApply"
              />
              <ImportBatch
                v-else-if="plan"
                :plan="plan"
                :busy="planning"
                @close="plan = undefined"
                @select="(key) => { selectedKey = key; area = 'inventory' }"
                @replan="buildPlan(plan.agent, $event)"
              />
              <template v-else-if="selectionPlan">
                <nav v-if="openedBatch" class="flex flex-wrap items-center gap-2" data-test="steps">
                  <h2 class="mr-2 text-base font-semibold text-zinc-100">{{ openedBatch.name }}</h2>
                  <button
                    v-for="(entry, index) in STEPS"
                    :key="entry.id"
                    type="button"
                    class="step"
                    :class="step === entry.id ? 'on' : ''"
                    :data-test="`step-${entry.id}`"
                    @click="goStep(entry.id)"
                  >
                    <span class="step-number">{{ index + 1 }}</span>{{ entry.label }}
                  </button>
                  <span class="flex-1" />
                  <button type="button" class="btn btn-ghost btn-sm" data-test="refresh-batch" @click="refreshStates(openedBatch.order.length ? openedBatch.order : openedBatch.keys)">Atualizar estados</button>
                </nav>

                <ImportSelectionBatch
                  v-if="!openedBatch || step === 'build'"
                  :plan="selectionPlan"
                  :batch="openedBatch"
                  :name="previewName"
                  :busy="batchBusy"
                  :readonly="readonly"
                  :error="batchError"
                  @close="closeSelection"
                  @select="(key) => { selectedKey = key; area = 'inventory' }"
                  @replan="buildSelection(selectionPlan.keys, $event)"
                  @save="saveBatch"
                  @prepare="saveAndPrepare"
                />

                <template v-else-if="step === 'prepare'">
                  <section class="flex flex-wrap items-center gap-2 text-xs" data-test="batch-builder">
                    <template v-if="batchGroups.length">
                      <button type="button" class="btn btn-primary btn-sm" :disabled="building" data-test="prepare-batch" @click="prepareBatch(openedBatch.id)">
                        {{ building ? 'Abrindo…' : `Preparar tudo com o construtor (${batchGroups.length} conversa${batchGroups.length > 1 ? 's' : ''})` }}
                      </button>
                      <button
                        v-for="group in batchGroups"
                        :key="group.kind"
                        type="button"
                        class="btn btn-secondary btn-sm"
                        :disabled="building"
                        data-test="build-saved-batch"
                        @click="openBuilder({ batchId: openedBatch.id, kind: group.kind })"
                      >
                        {{ building ? 'Abrindo…' : `Só ${BUILD_KINDS[group.kind].noun} (${group.keys.length})` }}
                      </button>
                    </template>
                    <span v-else class="text-zinc-400">Tudo desta migração já foi ao construtor. Revise ao lado de cada conversa; os aprovados vão para o passo Gravar.</span>
                    <button v-if="openedBatch && stepOf(openedBatch) === 'apply'" type="button" class="btn btn-secondary btn-sm" data-test="go-apply" @click="goStep('apply')">Ir para Gravar →</button>
                  </section>
                  <section v-if="prepared?.length" class="flex flex-col gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs" data-test="prepared">
                    <p class="text-emerald-200">
                      {{ prepared.length }} conversa(s) aberta(s) com o construtor. Clique "Começar" em cada uma; o rascunho aparece ao lado da conversa. Volte aqui e "Atualizar estados" para ver o
                      progresso.
                    </p>
                    <ul class="flex flex-col gap-1">
                      <li v-for="opened in prepared" :key="opened.conversationId" class="flex flex-wrap items-center gap-2">
                        <a
                          :href="buildLink(opened.kind, opened.conversationId)"
                          class="text-emerald-300 hover:underline"
                          data-test="prepared-link"
                          @click.prevent="router ? router.push(buildLink(opened.kind, opened.conversationId)) : undefined"
                          >{{ BUILD_KINDS[opened.kind].builder }}</a
                        >
                        <span class="text-zinc-500">{{ opened.keys.length }} item(ns): {{ opened.keys.slice(0, 4).join(', ') }}<template v-if="opened.keys.length > 4">, …</template></span>
                      </li>
                    </ul>
                  </section>
                  <ImportBatchProgress
                    :keys="openedBatch.order.length ? openedBatch.order : openedBatch.keys"
                    :items="itemMap"
                    :statuses="statuses"
                    :overrides="overrides"
                    @select="(key) => { selectedKey = key; area = 'inventory' }"
                  />
                </template>

                <ImportApply
                  v-else-if="step === 'apply' && job && project"
                  :key="`batch-${openedBatch.id}-${openedBatch.keys.length}`"
                  :project-id="project.id"
                  :job-id="job.id"
                  :target="{ batchId: openedBatch.id, label: `migração ${openedBatch.name}` }"
                  :readonly="readonly"
                  @close="step = 'prepare'"
                  @applied="applied"
                  @select="(key) => { selectedKey = key; area = 'inventory' }"
                  @build="openBuilder({ keys: $event })"
                  @include="includeInApply"
                />
              </template>
              <section v-else class="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400" data-test="batches-empty">
                <p class="font-medium text-zinc-200">Uma migração leva itens do inventário ao catálogo, em três passos.</p>
                <p class="mt-1">1. <strong>Montar</strong>: os itens (e as dependências), a ordem e o nome. 2. <strong>Preparar</strong>: o construtor faz os rascunhos e você revisa ao lado de cada conversa. 3. <strong>Gravar</strong>: os aprovados vão ao catálogo.</p>
                <p class="mt-2">Abra uma migração à esquerda, ou selecione itens no <button type="button" class="text-emerald-300 underline" @click="area = 'inventory'">Inventário</button> e clique "Migrar selecionados".</p>
              </section>
            </div>
          </section>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.area-tab {
  @apply shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-zinc-400 hover:text-zinc-200;
}
.area-tab.on {
  @apply border-emerald-500 text-zinc-100;
}
.step {
  @apply flex items-center gap-1.5 rounded-full border border-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-200;
}
.step.on {
  @apply border-emerald-500/60 bg-emerald-500/10 text-emerald-100;
}
.step-number {
  @apply grid h-4 w-4 place-items-center rounded-full bg-zinc-800 text-[10px] text-zinc-300;
}

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-xs font-medium text-zinc-400;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
