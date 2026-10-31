<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import ImportBatch from '@/components/ImportBatch.vue'
import ImportItemDetail from '@/components/ImportItemDetail.vue'
import ImportSelectionBatch from '@/components/ImportSelectionBatch.vue'
import { api, ApiError } from '@/lib/api'
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
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * O IMPORTADOR do projeto em uso (só admin): os TRABALHOS DE IMPORTAÇÃO do projeto (cada análise de um repositório,
 * salva) e o inventário do trabalho aberto — o que achou de recurso agêntico, com tamanho, citações, estado no catálogo,
 * o que não traduz e o estado de cada item. A pessoa exclui/inclui e reclassifica item a item; isso fica gravado no
 * trabalho, e analisar de novo reaproveita pela chave (a fonte que mudou depois da decisão aparece como "fonte mudou").
 *
 * A pessoa também SELECIONA itens (caixas na lista, ou "todos do filtro") e monta um LOTE da seleção: a ordem só entre
 * eles, as citações para fora e a estimativa. O lote pode ser salvo no trabalho, com nome; os lotes salvos ficam na lista.
 *
 * ⛔ Nada aqui grava no catálogo nem dispara construtor. Só o trabalho mais novo de cada repositório muda; os outros são
 * registro.
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
/** O ignorar do projeto: um padrão por linha, como está salvo e como está no campo. */
const ignoreSaved = ref<string[]>([])
const ignoreText = ref('')
const ignoreBusy = ref(false)
const ignoreMessage = ref<string>()
const ignoreError = ref<string>()
const ignoreDirty = computed(() => parseIgnore(ignoreText.value).join('\n') !== ignoreSaved.value.join('\n'))

const items = computed(() => scan.value?.items ?? [])
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

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const issues = (failure.details as Array<{ message?: string }>).map((item) => item.message).filter(Boolean)
    if (issues.length) return issues.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
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

/** A prévia do lote: as chaves escolhidas (na ordem da lista) e o prefixo. Não salva nada. */
async function buildSelection(keys = items.value.filter((item) => picked.value.has(item.key)).map((item) => item.key), nextPrefix = selectionPlan.value?.prefix ?? '') {
  if (!project.value || !job.value || !keys.length) return
  const fresh = !selectionPlan.value || !!openedBatch.value || keys.join('\n') !== selectionPlan.value.keys.join('\n')
  batchBusy.value = true
  batchError.value = undefined
  try {
    selectionPlan.value = await api<ISelectionPlan>(`${batchesPath()}/plan`, { method: 'POST', body: { keys, ...(nextPrefix ? { prefix: nextPrefix } : {}) } })
    if (fresh) previewName.value = batchName(items.value.filter((item) => keys.includes(item.key)), overrides.value)
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
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

async function openBatch(id: string) {
  if (!project.value || !job.value) return
  batchBusy.value = true
  batchError.value = undefined
  try {
    const view = await api<IImportBatchView>(`${batchesPath()}/${encodeURIComponent(id)}`)
    const { plan: batchPlan, ...record } = view
    openedBatch.value = record
    selectionPlan.value = batchPlan
  } catch (failure) {
    batchError.value = message(failure)
  } finally {
    batchBusy.value = false
  }
}

function closeSelection() {
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

          <section class="flex flex-wrap items-center gap-2 text-xs" data-test="selection">
            <span class="text-zinc-400" data-test="picked-count">{{ picked.size.toLocaleString('pt-BR') }} selecionado(s)</span>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="!filtered.length" data-test="pick-filtered" @click="pickFiltered">
              Selecionar os {{ filtered.length.toLocaleString('pt-BR') }} do filtro
            </button>
            <button v-if="picked.size" type="button" class="btn btn-ghost btn-sm" data-test="pick-clear" @click="clearPicked">Limpar seleção</button>
            <button type="button" class="btn btn-primary btn-sm" :disabled="!picked.size || batchBusy" data-test="build-batch" @click="buildSelection()">
              {{ batchBusy ? 'Montando…' : 'Montar lote da seleção' }}
            </button>
          </section>

          <section v-if="batches.length" class="flex flex-col gap-1.5" data-test="batches">
            <h2 class="text-xs font-medium text-zinc-500">Lotes deste trabalho ({{ batches.length }})</h2>
            <ul class="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
              <li v-for="entry in batches" :key="entry.id">
                <button
                  type="button"
                  class="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-left text-xs hover:bg-zinc-900"
                  :class="entry.id === openedBatch?.id ? 'bg-zinc-900' : ''"
                  data-test="batch-entry"
                  @click="openBatch(entry.id)"
                >
                  <span class="font-medium text-zinc-200">{{ entry.name }}</span>
                  <span class="text-zinc-500">{{ entry.keys.length }} item(ns) · {{ entry.order.length }} na ordem</span>
                  <span v-if="entry.prefix" class="text-zinc-500">prefixo <code>{{ entry.prefix }}</code></span>
                  <span class="text-zinc-500">por {{ entry.by }} · {{ fullTime(entry.at) }}</span>
                </button>
              </li>
            </ul>
          </section>
          <p v-if="batchError && !selectionPlan" class="text-sm text-rose-300" data-test="selection-error">Lote: {{ batchError }}</p>
          <ImportSelectionBatch
            v-if="selectionPlan"
            :plan="selectionPlan"
            :batch="openedBatch"
            :name="previewName"
            :busy="batchBusy"
            :readonly="readonly"
            :error="batchError"
            @close="closeSelection"
            @select="selectedKey = $event"
            @replan="buildSelection(selectionPlan.keys, $event)"
            @save="saveBatch"
          />

          <p v-if="planError" class="text-sm text-rose-300" data-test="plan-error">Lote: {{ planError }}</p>
          <ImportBatch v-if="plan" :plan="plan" :busy="planning" @close="plan = undefined" @select="selectedKey = $event" @replan="buildPlan(plan.agent, $event)" />

          <div class="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <section class="flex min-w-0 flex-col gap-2">
              <p class="text-xs text-zinc-500" data-test="count">{{ filtered.length.toLocaleString('pt-BR') }} de {{ items.length.toLocaleString('pt-BR') }} itens</p>
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
                @plan="buildPlan(selected.key)"
                @select="selectedKey = $event"
                @reclassify="reclassify(selected.key, $event)"
                @state="changeItem(selected.key, { state: $event })"
                @close="selectedKey = undefined"
              />
            </aside>
            <p v-else class="hidden rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500 lg:block">Escolha um item para ver as fontes, as citações e as notas.</p>
          </div>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-xs font-medium text-zinc-400;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-1.5 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
