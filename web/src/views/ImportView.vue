<script setup lang="ts">
import SaveFooter from '@/components/SaveFooter.vue'
import { useAgentsStore } from '@/stores/agents'
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import { routerKey } from 'vue-router'
import ImportApply from '@/components/ImportApply.vue'
import ImportBatch from '@/components/ImportBatch.vue'
import ImportPrepareDesk from '@/components/ImportPrepareDesk.vue'
import ImportScope from '@/components/ImportScope.vue'
import ImportItemDetail from '@/components/ImportItemDetail.vue'
import ImportSelectionBatch from '@/components/ImportSelectionBatch.vue'
import { useResource } from '@/composables/useResource'
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
  GONE_HINT,
  GONE_LABEL,
  groupByKind,
  type IImportAnalysis,
  type IImportBatch,
  type IImportFilters,
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
import { batchKey, type IImportJobView, jobKey, useImportsStore } from '@/stores/imports'
import { useProjectsStore } from '@/stores/projects'
import { useRepositoriesStore } from '@/stores/repositories'

/**
 * O IMPORTADOR do projeto em uso (só admin): os TRABALHOS DE IMPORTAÇÃO do projeto (cada análise de um repositório,
 * salva) e o inventário do trabalho aberto — o que achou de recurso agêntico, com tamanho, citações, estado no catálogo,
 * o que não traduz e o estado de cada item. A pessoa exclui/inclui e reclassifica item a item; isso fica gravado no
 * trabalho, e analisar de novo reaproveita pela chave (a fonte que mudou depois da decisão aparece como "fonte mudou").
 *
 * DUAS ÁREAS no trabalho aberto, para não misturar explorar com importar:
 * - INVENTÁRIO: o resumo, os filtros, a lista e o detalhe. A pessoa SELECIONA itens (caixas, ou "todos do filtro") e a
 *   barra de baixo leva a seleção para a área Migrações ("Migrar selecionados", com ou sem as dependências);
 * - LOTES: os lotes salvos do trabalho, com o progresso, e o lote aberto em PASSOS — Montar (a ordem, o que fica de
 *   fora, nome e prefixo), Preparar (cada item com o estado e a conversa do construtor; "preparar tudo") e Gravar (o
 *   plano do catálogo do lote: `ImportApply`, que só grava com o clique e uma caixa por ampliação).
 *
 * ⛔ Fora isso, nada aqui grava no catálogo nem dispara construtor. Há UMA importação por repositório: cada "Analisar" a atualiza no
 * mesmo lugar e entra no histórico de análises.
 *
 * ⚖️ Tudo o que vem do servidor mora na store (`useImportsStore`, `useRepositoriesStore`): a tela garante (`ensure`) o
 * que mostra, e as gravações põem a resposta lá — a fila de revisão e a mesa do Preparar leem a mesma cópia.
 */
const PAGE = 100
const CATALOG_STATES: readonly TCatalogState[] = ['new', 'same-project', 'global', 'other-project']

const projects = useProjectsStore()
const project = computed(() => projects.list.find((item) => item.id === projects.current))
const imports = useImportsStore()
/** O projeto das leituras do importador (só quem administra o projeto). */
const projectId = computed(() => (projects.manages ? project.value?.id : undefined))

const { data: repositoryList, error: repositoryError } = useResource(useRepositoriesStore().lists, projectId)
const repositories = computed(() => (repositoryList.value ?? []).map((item) => item.name))
const repository = ref('')
const busy = ref(false)
const actionError = ref<string>()
/** Os trabalhos do projeto (mais novo primeiro) e o aberto (da store, pelo id). */
const { data: jobList, error: jobsError } = useResource(imports.jobs, projectId)
const jobs = computed(() => jobList.value ?? [])
const openedJobId = ref<string>()
const openedJobKey = computed(() => (projectId.value && openedJobId.value ? jobKey(projectId.value, openedJobId.value) : undefined))
const job = computed<IImportJobView | undefined>(() => (openedJobKey.value ? imports.job.get(openedJobKey.value) : undefined))
const scan = computed(() => job.value?.scan)
/** O estado de cada item do trabalho aberto, pela chave: a cópia da store (o que muda item a item). */
const statuses = computed<Readonly<Record<string, IImportBuildStatus>>>(() => (projectId.value && job.value ? imports.statesOf(projectId.value, job.value.id) : {}))
const error = computed(() => actionError.value ?? [repositoryError.value, jobsError.value].map((failure) => (failure === undefined ? undefined : message(failure))).find(Boolean))
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
/** A prévia da seleção (não salva) e o lote salvo aberto (da store, pelo id): o lote mostrado é o dele, senão a prévia. */
const previewPlan = shallowRef<ISelectionPlan>()
const openedBatchId = ref<string>()
const openedBatch = computed(() => (projectId.value && job.value && openedBatchId.value ? imports.batch.get(batchKey(projectId.value, job.value.id, openedBatchId.value)) : undefined))
const selectionPlan = computed(() => openedBatch.value?.plan ?? previewPlan.value)
const previewName = ref('')
const { data: batchList, error: batchesError } = useResource(imports.batches, openedJobKey)
const batches = computed(() => batchList.value ?? [])
const batchBusy = ref(false)
const batchError = ref<string>()
watch(batchesError, (failure) => {
  if (failure !== undefined) batchError.value = message(failure)
})
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
/** O ignorar do projeto: um padrão por linha, como está salvo (na store) e como está no campo. */
const { data: ignoreData, error: ignoreLoadError } = useResource(imports.ignore, projectId)
const ignoreSaved = computed(() => ignoreData.value ?? [])
const ignoreText = ref('')
watch(ignoreData, (patterns) => (ignoreText.value = (patterns ?? []).join('\n')), { immediate: true })
const ignoreBusy = ref(false)
const ignoreMessage = ref<string>()
const ignoreSaveError = ref<string>()
const ignoreError = computed(() => ignoreSaveError.value ?? (ignoreLoadError.value === undefined ? undefined : message(ignoreLoadError.value)))
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
    const status = statuses.value[key]
    const state = status?.state ?? 'pending'
    if (!item || !BUILDABLE_STATES.includes(state) || state === 'review' || (state === 'drafting' && !draftingWithoutConversation(status))) continue
    const kind = builderKindFor(effectiveKind(item, overrides.value))
    if (kind) groups.set(kind, [...(groups.get(kind) ?? []), key])
  }
  return [...groups.entries()].map(([kind, list]) => ({ kind, keys: list }))
}

/** Guarda o item que o servidor devolveu e recontá os estados do trabalho na lista. */
/** Gravar no catálogo: o alvo aberto (lote salvo, seleção ou todo o trabalho). */
const applyTarget = ref<{ batchId?: string; keys?: string[]; label: string }>()
const approvedCount = computed(() => Object.values(statuses.value).filter((entry) => entry.state === 'approved' && !entry.goneAt).length)

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
 * "Atualizar estados": os estados de AGORA dos itens do lote (a pessoa revisou noutra aba, outra pessoa revisou) e o
 * lote recalculado sobre eles, na store.
 */
async function refreshStates(keys: readonly string[]) {
  if (!projectId.value || !job.value || !keys.length) return
  const opened = openedBatch.value
  try {
    await Promise.all([imports.refreshItems(projectId.value, job.value.id, keys), opened ? imports.batch.refresh(batchKey(projectId.value, job.value.id, opened.id)) : undefined])
  } catch (failure) {
    batchError.value = message(failure)
  }
}

/** ⚖️ Abrir o Preparar não relê nada: a fila de revisão garante o estado completo dos itens, na store. */
function goStep(next: TStep) {
  step.value = next
}

/** Os agentes da migração (o alcance e as permissões de cada um aparecem no Montar). */
function agentsOf(keys: readonly string[]): string[] {
  return keys.filter((key) => {
    const item = itemMap.value.get(key)
    return !!item && effectiveKind(item, overrides.value) === 'agent'
  })
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
/** "Adicionar à migração" (no passo Gravar): as faltas entram na migração, e a gravação é refeita com elas. */
function includeInApply(keys: string[]) {
  // Na migração salva, a falta entra NELA com as dependências: a aprovada fica no Gravar; a que falta preparar leva ao Preparar.
  if (openedBatch.value && step.value === 'apply') return void addToBatch(openedBatch.value.id, keys, true)
  if (!applyTarget.value?.keys) return
  const next = [...new Set([...applyTarget.value.keys, ...keys])]
  picked.value = new Set([...picked.value, ...keys])
  applyTarget.value = { keys: next, label: `${next.length} selecionado(s)` }
}

function applied(result: IApplyResult) {
  if (projectId.value && job.value) imports.markApplied(projectId.value, job.value.id, result)
}

function parseIgnore(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))]
}

/** O painel do ambiente agêntico (montado embutido): o rodapé grava o rascunho dele junto com o ignorar. */
const scopePart = ref<{ dirty: boolean; commit: () => Promise<void> }>()
async function saveAnalysis() {
  if (ignoreDirty.value) await saveIgnore()
  await scopePart.value?.commit().catch(() => undefined)
}

async function saveIgnore() {
  if (!projectId.value) return
  ignoreBusy.value = true
  ignoreMessage.value = undefined
  ignoreSaveError.value = undefined
  try {
    await imports.saveIgnore(projectId.value, parseIgnore(ignoreText.value))
    ignoreMessage.value = scan.value ? 'Salvo. Analise de novo para aplicar.' : 'Salvo.'
  } catch (failure) {
    ignoreSaveError.value = message(failure)
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
  for (const item of filtered.value) if (!isGone(item.key)) next.add(item.key)
  picked.value = next
}

function clearPicked() {
  picked.value = new Set()
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
  applyAll.value = false
  plan.value = undefined
  area.value = 'batches'
  step.value = 'build'
  try {
    previewPlan.value = await api<ISelectionPlan>(`${batchesPath()}/plan`, { method: 'POST', body: { keys, ...(nextPrefix ? { prefix: nextPrefix } : {}), ...(closure ? { closure } : {}) } })
    if (closure && keys.length === 1) previewName.value = `${keys[0].slice(keys[0].indexOf(':') + 1)} e dependências`
    else if (fresh) previewName.value = batchName(items.value.filter((item) => keys.includes(item.key)), overrides.value)
    openedBatchId.value = undefined
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** Salva a prévia como lote do trabalho (nome, itens, ordem). ⛔ Não dispara nada nem grava no catálogo. */
async function saveBatch(name: string) {
  if (!projectId.value || !job.value || !selectionPlan.value || readonly.value) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const plan = selectionPlan.value
    const view = await imports.createBatch(projectId.value, job.value.id, { name, keys: plan.keys, ...(plan.prefix ? { prefix: plan.prefix } : {}) })
    openedBatchId.value = view.id
    previewPlan.value = undefined
    step.value = 'prepare'
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** Acrescenta itens a uma migração salva (com as dependências, se pedido) e a abre com o estado de agora. */
async function addToBatch(batchId: string, keys: readonly string[], closure = false, keepStep = false) {
  if (!projectId.value || !job.value || readonly.value || !keys.length) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const view = await imports.addToBatch(projectId.value, job.value.id, batchId, { keys, ...(closure ? { closure } : {}) })
    openedBatchId.value = view.id
    previewPlan.value = undefined
    applyAll.value = false
    plan.value = undefined
    area.value = 'batches'
    if (!keepStep) step.value = stepOf(view)
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

/** A migração salva que recebe a seleção do inventário ("Adicionar à migração"). */
const addTarget = ref('')
/** Migrar e adicionar trazem as dependências da seleção (o padrão: a migração sai completa). */
const withDependencies = ref(true)

/** Abre a migração salva (da store, lida uma vez) no passo em que ela está, com o estado completo dos itens. */
async function openBatch(id: string) {
  if (!projectId.value || !job.value) return
  const jobId = job.value.id
  batchBusy.value = true
  batchError.value = undefined
  try {
    const view = await imports.batch.ensure(batchKey(projectId.value, jobId, id))
    applyAll.value = false
    applyTarget.value = undefined
    plan.value = undefined
    openedBatchId.value = id
    previewPlan.value = undefined
    area.value = 'batches'
    await imports.ensureItems(projectId.value, jobId, view.order.length ? view.order : view.keys)
    step.value = stepOf(view)
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

function closeSelection() {
  previewPlan.value = undefined
  openedBatchId.value = undefined
  batchError.value = undefined
}

/** Abre o trabalho (já na store): o inventário, os estados e a tela limpa. */
function show(opened: IImportJobView) {
  openedJobId.value = opened.id
  repository.value = opened.repository
  selectedKey.value = undefined
  plan.value = undefined
  planError.value = undefined
  itemError.value = undefined
  filters.value = { ...EMPTY_FILTERS }
  limit.value = PAGE
  picked.value = new Set()
  applyTarget.value = undefined
  applyAll.value = false
  area.value = 'inventory'
  closeSelection()
}

async function openJob(id: string) {
  if (!projectId.value) return
  busy.value = true
  actionError.value = undefined
  try {
    show(await imports.job.ensure(jobKey(projectId.value, id)))
  } catch (failure) {
    actionError.value = message(failure)
  } finally {
    busy.value = false
  }
}

/** Muda um item do trabalho aberto (excluir/incluir, reclassificar) e guarda o que o servidor devolveu. */
async function changeItem(key: string, change: { state?: 'pending' | 'skipped'; kind?: TInventoryKind | null }) {
  if (!projectId.value || !job.value || readonly.value) return
  itemBusy.value = true
  itemError.value = undefined
  try {
    await imports.updateItem(projectId.value, job.value.id, key, change)
  } catch (failure) {
    itemError.value = message(failure)
  } finally {
    itemBusy.value = false
  }
}

/** O repositório escolhido: o primeiro do projeto, ao trocar de projeto ou quando o escolhido não existe mais. */
watch(
  [() => projects.current, repositories],
  ([current], [before]) => {
    if (current !== before || !repositories.value.includes(repository.value)) repository.value = repositories.value[0] ?? ''
  },
  { immediate: true },
)

async function analyze() {
  if (!projectId.value || !repository.value) return
  busy.value = true
  actionError.value = undefined
  try {
    const { job: analyzed } = await imports.analyze(projectId.value, repository.value)
    // ⚖️ Reanálise da importação já aberta: a tela fica onde está (seleção, filtros, migração aberta).
    if (openedJobId.value !== analyzed.id) show(analyzed)
  } catch (failure) {
    actionError.value = message(failure)
  } finally {
    busy.value = false
  }
}

function reset() {
  openedJobId.value = undefined
  ignoreMessage.value = undefined
  ignoreSaveError.value = undefined
  plan.value = undefined
  planError.value = undefined
  itemError.value = undefined
  selectedKey.value = undefined
  filters.value = { ...EMPTY_FILTERS }
  actionError.value = undefined
  picked.value = new Set()
  closeSelection()
}

function reclassify(key: string, kind: TInventoryKind | undefined) {
  void changeItem(key, { kind: kind ?? null })
}

function stateOf(item: IInventoryItem): TImportItemState {
  return statuses.value[item.key]?.state ?? 'pending'
}

const isGone = (key: string) => !!statuses.value[key]?.goneAt

/** "Importado pela Maya": o item que um agente gravou por fora do importador (o nome, se o agente existe). */
function importedLabel(key: string): string | undefined {
  const by = statuses.value[key]?.importedBy
  if (!by) return undefined
  const who = by.agentId ? (useAgentsStore().byId.get(by.agentId)?.name ?? by.agentId) : (statuses.value[key]?.by ?? 'fora do importador')
  const more = (by.targets?.length ?? 1) - 1
  return `importado por ${who} → ${by.kind} ${by.id}${more > 0 ? ` (+${more})` : ''}`
}

/** O que uma análise mudou, em texto curto: mantidos, fonte mudada, novos, saíram, fonte de volta, voltaram. */
function analysisText(one: IImportAnalysis): string {
  const parts = [`${one.kept} mantido(s)`]
  if (one.stale.length) parts.push(`${one.stale.length} com fonte mudada`)
  if (one.added.length) parts.push(`${one.added.length} novo(s)`)
  if (one.gone.length) parts.push(`${one.gone.length} saíram da fonte`)
  if (one.restored.length) parts.push(`${one.restored.length} com a fonte de volta`)
  if (one.returned.length) parts.push(`${one.returned.length} voltaram`)
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
  if (!projects.loaded) await projects.load().catch(() => undefined)
})
// ⚖️ As leituras seguem o projeto sozinhas (`useResource`): trocar de projeto só limpa a tela.
watch(() => projects.current, reset)
</script>

<template>
  <div v-if="!projects.manages" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra este projeto usa o importador.</p>
  </div>

  <div v-else class="h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-6xl flex-col gap-4">
      <header>
        <h1 class="text-xl font-semibold">Importador{{ project ? ` — ${project.name}` : '' }}</h1>
        <p class="text-xs text-zinc-500">
          O que um repositório do projeto tem de agentes, skills, commands, rules e docs, e como isso chegaria ao catálogo. Cada repositório tem uma importação só: analisar de novo a
          atualiza, guardando o que você já decidiu item a item. Nada vai ao catálogo.
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
          <h2 class="text-xs font-medium text-zinc-500">Importações ({{ jobs.length }})</h2>
          <ul class="flex max-h-56 flex-col divide-y divide-zinc-800 overflow-y-auto rounded-xl border border-zinc-800">
            <li v-for="entry in jobs" :key="entry.id" data-test="job-entry">
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
                <span v-if="entry.gone" class="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-200" :title="GONE_HINT">{{ entry.gone }} {{ GONE_LABEL }}</span>
              </button>
              <details v-if="entry.analyses?.length" class="px-3 pb-1.5 text-xs text-zinc-400" data-test="analyses">
                <summary class="cursor-pointer text-zinc-500">{{ entry.analyses.length }} análise(s)</summary>
                <ul class="mt-1 flex flex-col gap-0.5">
                  <li v-for="one in entry.analyses" :key="one.at" class="flex flex-wrap items-center gap-x-3" data-test="analysis">
                    <span>{{ fullTime(one.at) }}</span>
                    <span class="text-zinc-500">por {{ one.by }}</span>
                    <code v-if="one.head" class="text-zinc-500" :title="one.head">{{ one.head.slice(0, 12) }}</code>
                    <span v-if="one.dirty" class="text-amber-200">árvore suja</span>
                    <span>{{ analysisText(one) }}</span>
                  </li>
                </ul>
              </details>
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
              <span v-if="ignoreDirty" class="text-amber-300">Mudança não salva</span>
              <span v-if="ignoreMessage" class="text-emerald-300">{{ ignoreMessage }}</span>
              <span v-if="ignoreError" class="text-rose-300" data-test="ignore-error">{{ ignoreError }}</span>
            </div>
          </form>
        </details>

        <ImportScope ref="scopePart" :project-id="projectId" :scope="scan?.scope" embedded />
        <!-- Um salvar só para a configuração da análise (o ignorar e o ambiente): aparece quando há o que gravar. -->
        <SaveFooter
          v-if="ignoreDirty || scopePart?.dirty"
          label="Salvar configuração da análise"
          :busy="ignoreBusy"
          pending
          data-test="analysis-save"
          @save="saveAnalysis"
        />

        <template v-if="scan">
          <nav class="no-scrollbar flex gap-1 overflow-x-auto border-b border-zinc-800" role="tablist" data-test="areas">
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
              <p v-if="job?.analyses?.[0]" class="text-xs text-zinc-400" data-test="last-analysis">Última análise: {{ analysisText(job.analyses[0]) }}</p>
              <p v-if="job?.gone" class="text-xs text-amber-200" data-test="gone-summary">{{ job.gone }} {{ GONE_LABEL }}: ficam fora do Preparar e da gravação. Decida: excluir ou deixar.</p>
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
                        <input type="checkbox" class="accent-sky-500" :checked="picked.has(item.key)" :disabled="isGone(item.key)" :aria-label="`Selecionar ${item.key}`" data-test="pick" @change="togglePick(item.key)" />
                      </label>
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-left hover:bg-zinc-900"
                        :class="item.key === selectedKey ? 'bg-zinc-900' : ''"
                        data-test="row"
                        @click="selectedKey = item.key"
                      >
                        <span class="flex flex-wrap items-center gap-2">
                          <span v-if="isGone(item.key)" class="rounded-full bg-amber-500/15 px-2 text-[11px] text-amber-200" :title="GONE_HINT" data-test="gone-badge">{{ GONE_LABEL }}</span>
                          <span
                            v-if="importedLabel(item.key)"
                            class="rounded-full bg-sky-500/15 px-2 text-[11px] text-sky-200"
                            title="Gravado no catálogo por um agente, fora do importador"
                            data-test="imported-badge"
                            >{{ importedLabel(item.key) }}</span
                          >
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
                class="max-lg:fixed max-lg:inset-0 max-lg:z-40 max-lg:overflow-y-auto max-lg:bg-zinc-950 max-lg:px-4 max-lg:py-5 lg:sticky lg:top-0 lg:max-h-[calc(100vh-2.5rem)] lg:overflow-y-auto lg:rounded-xl lg:border lg:border-zinc-800 lg:p-3"
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
                :migrations="batches.filter((entry) => entry.keys.includes(selected!.key)).map((entry) => ({ id: entry.id, name: entry.name }))"
                @migration="openBatch($event)"
                @select="selectedKey = $event"
                @reclassify="reclassify(selected.key, $event)"
                @state="changeItem(selected.key, { state: $event })"
                @close="selectedKey = undefined"
              />
              </aside>
              <p v-else class="hidden rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500 lg:block">Escolha um item para ver as fontes, as citações e as notas.</p>
            </div>

            <!-- A seleção: uma barra fixa embaixo, destacada do fundo, só com o que leva à migração. -->
            <section
              v-if="items.length"
              class="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/95 px-3 py-2 text-xs shadow-[0_-6px_24px_rgba(0,0,0,0.55)] backdrop-blur"
              :class="picked.size ? 'border-emerald-500/50' : ''"
              data-test="selection"
            >
              <span class="rounded-full px-2 py-0.5 font-medium" :class="picked.size ? 'bg-emerald-500/20 text-emerald-100' : 'bg-zinc-900 text-zinc-300'" data-test="picked-count"
                >{{ picked.size.toLocaleString('pt-BR') }} selecionado(s)</span
              >
              <button type="button" class="btn btn-ghost btn-sm" :disabled="!filtered.length" data-test="pick-filtered" @click="pickFiltered">
                Selecionar os {{ filtered.length.toLocaleString('pt-BR') }} do filtro
              </button>
              <button v-if="picked.size" type="button" class="btn btn-ghost btn-sm" data-test="pick-clear" @click="clearPicked">Limpar</button>
              <span class="flex-1" />
              <label class="flex items-center gap-1.5 text-zinc-200" title="Traz o que os selecionados citam (e, no agente, os triggers), em ordem">
                <input v-model="withDependencies" type="checkbox" class="accent-emerald-500" data-test="with-dependencies" />
                com dependências
              </label>
              <template v-if="batches.length && !readonly">
                <select v-model="addTarget" class="input py-1 text-xs" aria-label="Migração que recebe a seleção" data-test="add-target">
                  <option value="" disabled>Adicionar à migração…</option>
                  <option v-for="entry in batches" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                </select>
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="!picked.size || !addTarget || batchBusy"
                  data-test="add-to-batch"
                  @click="addToBatch(addTarget, items.filter((item) => picked.has(item.key)).map((item) => item.key), withDependencies)"
                >
                  Adicionar
                </button>
              </template>
              <button type="button" class="btn btn-primary btn-sm" :disabled="!picked.size || batchBusy" data-test="build-batch" @click="buildSelection(undefined, '', withDependencies)">
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
                    <span v-if="entry.gone?.length" class="text-amber-200" data-test="batch-entry-gone">{{ entry.gone.length }} saíram da fonte</span>
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
                @include="includeInApply"
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
                />

                <template v-else-if="step === 'prepare'">
                  <section v-if="stepOf(openedBatch) === 'apply'" class="flex flex-wrap items-center gap-2 text-xs" data-test="batch-builder">
                    <span class="text-zinc-400">Os aprovados já podem ir ao catálogo; o que falta revisar continua aqui.</span>
                    <button type="button" class="btn btn-secondary btn-sm" data-test="go-apply" @click="goStep('apply')">Ir para Gravar →</button>
                  </section>
                  <ImportPrepareDesk
                    :key="openedBatch.id"
                    :project-id="project!.id"
                    :job-id="job!.id"
                    :batch-id="openedBatch.id"
                    :keys="openedBatch.order.length ? openedBatch.order : openedBatch.keys"
                    :items="itemMap"
                    :overrides="overrides"
                    :readonly="readonly"
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
                  @include="includeInApply"
                />
                <!-- O alcance e as permissões do agente da migração (só leitura), no Montar. -->
                <section v-if="(!openedBatch || step === 'build') && agentsOf(selectionPlan.keys).length" class="flex flex-wrap items-center gap-2 text-xs" data-test="agent-reach">
                  <span class="text-zinc-400">Alcance e permissões:</span>
                  <button
                    v-for="key in agentsOf(selectionPlan.keys)"
                    :key="key"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="planning"
                    data-test="agent-plan"
                    @click="buildPlan(key)"
                  >
                    {{ planning ? 'Calculando…' : key.slice(key.indexOf(':') + 1) }}
                  </button>
                </section>
                <ImportBatch
                  v-if="plan && (!openedBatch || step === 'build')"
                  :plan="plan"
                  :busy="planning"
                  @close="plan = undefined"
                  @select="(key) => { selectedKey = key; area = 'inventory' }"
                  @replan="buildPlan(plan.agent, $event)"
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
