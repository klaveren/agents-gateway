<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ImportDraftAside from '@/components/ImportDraftAside.vue'
import ThreadView from '@/components/ThreadView.vue'
import { useResource } from '@/composables/useResource'
import { ApiError } from '@/lib/api'
import { BUILD_KINDS, importBuilderAgentId } from '@/lib/builder'
import { builderKindFor, draftingWithoutConversation, type IImportBatchRun, type IImportBuildStatus, runBusy } from '@/lib/importDraft'
import { effectiveKind, type IInventoryItem, type TInventoryKind, type TOverrides } from '@/lib/importer'
import { batchKey, useImportsStore } from '@/stores/imports'
import { useThreadStore } from '@/stores/thread'

/**
 * A MESA DO PASSO PREPARAR: o construtor trabalha NO SERVIDOR ("Preparar tudo": as conversas da migração rodam sem aba
 * aberta, algumas de cada vez) e a pessoa revisa numa fila só, da migração inteira, filtrada por tipo. A conversa é
 * secundária: abre num painel por cima, quando um item pede (dúvida, erro, ajuste). ⛔ Aprovar não grava no catálogo
 * (é do passo Gravar).
 */
const props = defineProps<{
  projectId: string
  jobId: string
  batchId: string
  keys: readonly string[]
  items: ReadonlyMap<string, IInventoryItem>
  overrides: TOverrides
  readonly: boolean
}>()

const thread = useThreadStore()
const imports = useImportsStore()

/** As conversas do lote, da store (o "Preparar tudo" e a releitura do andamento gravam lá). */
const runsKey = computed(() => batchKey(props.projectId, props.jobId, props.batchId))
const { data: runList, error: runError } = useResource(imports.runs, runsKey)
const runs = computed(() => runList.value ?? [])
const actionError = ref<string>()
const loadError = computed(() => actionError.value ?? (runError.value === undefined ? undefined : message(runError.value)))
const concurrency = ref(3)
const confirming = ref(false)
const starting = ref(false)
/** A fila recarrega quando muda (o andamento do servidor, a cada volta enquanto alguma conversa roda). */
const tick = ref(0)
/** O tipo filtrado na fila (`all`: todos) e a conversa aberta no painel. */
const filter = ref<TInventoryKind | 'all'>('all')
const drawer = ref<string>()

function message(failure: unknown): string {
  if (failure instanceof ApiError && Array.isArray(failure.details)) {
    const issues = (failure.details as Array<{ message?: string }>).map((item) => item.message).filter(Boolean)
    if (issues.length) return issues.join('; ')
  }
  return failure instanceof Error ? failure.message : String(failure)
}

const statusOf = (key: string): IImportBuildStatus | undefined => imports.statesOf(props.projectId, props.jobId)[key]
const kindOf = (key: string): TInventoryKind | undefined => {
  const item = props.items.get(key)
  return item ? effectiveKind(item, props.overrides) : undefined
}
/** ⛔ O que saiu da fonte nunca vai ao construtor: fica fora da mesa (e do "Preparar tudo"), só contado. */
const gone = computed(() => props.keys.filter((key) => !!statusOf(key)?.goneAt))
/** Só o que tem construtor entra na mesa. */
const buildable = computed(() => props.keys.filter((key) => {
  const kind = kindOf(key)
  return !!kind && !!builderKindFor(kind) && !statusOf(key)?.goneAt
}))

/** A conversa (de servidor) de cada item e as que estão na fila ou rodando. */
const runOf = computed(() => new Map(runs.value.flatMap((run) => run.keys.map((key) => [key, run] as const))))
const working = computed(() => new Set(runs.value.filter(runBusy).flatMap((run) => run.pending)))
const active = computed(() => runs.value.some(runBusy))

/** O que ainda não foi ao construtor (sem conversa, ou a conversa sumiu). */
const notSent = computed(() =>
  buildable.value.filter((key) => {
    const status = statusOf(key)
    return !status || ['pending', 'rejected', 'error', 'stale'].includes(status.state) || draftingWithoutConversation(status)
  }),
)
/** As conversas que o "Preparar tudo" põe para rodar: as que devem rascunho e não estão rodando. */
const idleRuns = computed(() => runs.value.filter((run) => run.pending.length && !runBusy(run)))
const toStart = computed(() => idleRuns.value.length + (notSent.value.length ? 1 : 0))

const count = (state: string) => buildable.value.filter((key) => statusOf(key)?.state === state).length
const totals = computed(() => ({
  review: count('review'),
  done: count('approved') + count('applied'),
  working: working.value.size,
  idle: idleRuns.value.reduce((sum, run) => sum + run.pending.length, 0),
}))

/** O andamento no lugar do estado, item a item, enquanto o item está com o construtor. */
const badges = computed(() => {
  const out: Record<string, { label: string; hint?: string; tone: 'work' | 'idle' }> = {}
  for (const key of buildable.value) {
    const run = runOf.value.get(key)
    if (!run || statusOf(key)?.state !== 'drafting') continue
    if (working.value.has(key)) out[key] = { label: run.run?.state === 'queued' ? 'na fila' : 'construtor trabalhando', tone: 'work' }
    else
      out[key] = {
        label: run.run?.state === 'error' ? 'erro no construtor' : 'parado',
        hint: run.run?.error ?? 'O construtor não está trabalhando nele: use "Preparar tudo" ou abra a conversa.',
        tone: 'idle',
      }
  }
  return out
})

/** Os tipos da migração, com as contagens: filtram a fila. */
const LABEL = (kind: TInventoryKind) => (kind === 'trigger' ? 'Triggers' : BUILD_KINDS[builderKindFor(kind)!].title)
const kinds = computed(() => {
  const groups = new Map<TInventoryKind, string[]>()
  for (const key of buildable.value) groups.set(kindOf(key)!, [...(groups.get(kindOf(key)!) ?? []), key])
  return [...groups.entries()].map(([kind, keys]) => ({
    kind,
    label: LABEL(kind),
    keys,
    review: keys.filter((key) => statusOf(key)?.state === 'review').length,
    working: keys.some((key) => working.value.has(key)),
    failed: keys.some((key) => badges.value[key]?.label === 'erro no construtor'),
  }))
})
const shownKeys = computed(() => (filter.value === 'all' ? buildable.value : (kinds.value.find((entry) => entry.kind === filter.value)?.keys ?? [])))

/** Enquanto alguma conversa roda, o andamento e a fila se atualizam sozinhos; ao parar, uma última vez. */
let timer: ReturnType<typeof setInterval> | undefined
watch(
  active,
  (now, before) => {
    if (now && !timer)
      timer = setInterval(() => {
        void imports.runs.refresh(runsKey.value).catch(() => undefined)
        tick.value += 1
      }, 5_000)
    if (!now && timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (!now && before) tick.value += 1
  },
  { immediate: true },
)
onBeforeUnmount(() => timer && clearInterval(timer))

async function startAll() {
  confirming.value = false
  starting.value = true
  actionError.value = undefined
  try {
    await imports.prepare(props.projectId, props.jobId, props.batchId, concurrency.value)
    tick.value += 1
  } catch (failure) {
    actionError.value = message(failure)
  } finally {
    starting.value = false
  }
}

// ── O painel da conversa ────────────────────────────────────────────────────

const opened = computed(() => runs.value.find((run) => run.conversationId === drawer.value))
watch(drawer, (id) => {
  if (id && thread.sessionId !== id) void thread.open(id)
})
const RUN_LABEL: Record<NonNullable<IImportBatchRun['run']>['state'], string> = { queued: 'na fila', running: 'trabalhando', ok: 'terminou', error: 'erro', aborted: 'interrompida' }
</script>

<template>
  <section class="flex flex-col gap-3" data-test="prepare-desk">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs" data-test="desk-progress">
      <span class="text-zinc-200">{{ buildable.length }} itens</span>
      <span v-if="totals.working" class="animate-pulse text-sky-300">{{ totals.working }} com o construtor</span>
      <span v-if="notSent.length" class="text-zinc-400">{{ notSent.length }} ainda não foram</span>
      <span v-if="gone.length" class="text-amber-200" data-test="desk-gone" :title="gone.join(', ')">{{ gone.length }} saíram da fonte: ficam fora do Preparar</span>
      <span v-if="totals.idle" class="text-orange-300">{{ totals.idle }} parados</span>
      <span class="text-amber-300">{{ totals.review }} a revisar</span>
      <span class="text-emerald-300">{{ totals.done }} aprovados</span>
      <span class="flex-1" />
      <template v-if="!readonly && toStart && !confirming">
        <label class="flex items-center gap-1 text-zinc-400" title="Quantas conversas o construtor toca ao mesmo tempo">
          juntas
          <input v-model.number="concurrency" type="number" min="1" max="5" class="input w-14 py-0.5" data-test="desk-concurrency" />
        </label>
        <button type="button" class="btn btn-primary btn-sm" :disabled="starting" data-test="desk-start-all" @click="confirming = true">
          {{ starting ? 'Começando…' : notSent.length || !runs.length ? 'Preparar tudo' : 'Retomar as paradas' }}
        </button>
      </template>
    </div>

    <div v-if="confirming" class="flex flex-col gap-2 rounded-xl border border-sky-500/40 bg-sky-500/5 p-3 text-xs" data-test="desk-confirm">
      <p class="text-zinc-200">
        O construtor vai rodar no servidor<template v-if="notSent.length"> (abrindo as conversas dos {{ notSent.length }} itens que ainda não foram)</template>, {{ concurrency }} conversa(s) por vez,
        gastando tokens sem você acompanhando. Pode sair da tela: o andamento fica aqui.
      </p>
      <div class="flex gap-2">
        <button type="button" class="btn btn-primary btn-sm" data-test="desk-confirm-start" @click="startAll">Começar</button>
        <button type="button" class="btn btn-ghost btn-sm" @click="confirming = false">Cancelar</button>
      </div>
    </div>
    <p v-if="loadError" class="text-xs text-rose-300" data-test="desk-error">{{ loadError }}</p>

    <nav class="flex flex-wrap gap-1.5" aria-label="Tipos da migração" data-test="desk-kinds">
      <button type="button" class="chip" :class="filter === 'all' ? 'chip-on' : ''" @click="filter = 'all'">Todos ({{ buildable.length }})</button>
      <button v-for="entry in kinds" :key="entry.kind" type="button" class="chip" :class="filter === entry.kind ? 'chip-on' : ''" data-test="desk-kind" @click="filter = entry.kind">
        {{ entry.label }} ({{ entry.keys.length }})
        <span v-if="entry.working" class="ml-1 animate-pulse text-sky-300">●</span>
        <span v-if="entry.failed" class="ml-1 text-rose-300">erro</span>
        <span v-if="entry.review" class="ml-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-200">{{ entry.review }}</span>
      </button>
    </nav>

    <ImportDraftAside
      :project-id="projectId"
      :job-id="jobId"
      :keys="shownKeys"
      :refresh="tick"
      scope="nesta lista"
      :badges="badges"
      with-conversation
      @conversation="drawer = $event"
    />

    <Teleport to="body">
      <div v-if="drawer" class="fixed inset-0 z-40 flex justify-end bg-black/50" data-test="desk-drawer" @click.self="drawer = undefined" @keydown.esc="drawer = undefined">
        <aside class="flex h-full w-full max-w-3xl flex-col overflow-hidden border-l border-zinc-700 bg-zinc-950" aria-label="Conversa do construtor">
          <header class="flex flex-col gap-2 border-b border-zinc-800 px-3 py-2">
            <div class="flex items-center gap-2 text-sm">
              <span class="font-medium text-zinc-200">{{ opened ? BUILD_KINDS[opened.kind].builder : 'Conversa' }}</span>
              <span v-if="opened?.run" class="text-xs text-zinc-400" :title="opened.run.error">· {{ RUN_LABEL[opened.run.state] }}</span>
              <span class="flex-1" />
              <button type="button" class="btn btn-ghost btn-sm" data-test="desk-drawer-close" @click="drawer = undefined">Fechar</button>
            </div>
            <nav class="scroll-thin flex gap-1 overflow-x-auto" aria-label="Conversas da migração">
              <button
                v-for="run in runs"
                :key="run.conversationId"
                type="button"
                class="chip shrink-0"
                :class="run.conversationId === drawer ? 'chip-on' : ''"
                data-test="desk-drawer-tab"
                @click="drawer = run.conversationId"
              >
                {{ BUILD_KINDS[run.kind].title }} · {{ run.keys.length }}
                <span v-if="runBusy(run)" class="ml-1 animate-pulse text-sky-300">●</span>
              </button>
            </nav>
          </header>
          <!-- ⚖️ min-h-0: sem isso o ThreadView (h-full) soma a altura do cabeçalho e o campo de mensagem fica abaixo da tela. -->
          <div v-if="opened" class="min-h-0 flex-1">
            <ThreadView :key="opened.conversationId" embedded :agent-id="importBuilderAgentId(opened.kind)" mode="agent" />
          </div>
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
@reference '../style.css';

.chip {
  @apply rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800;
}
.chip-on {
  @apply border-emerald-500/60 bg-emerald-500/10 text-emerald-100;
}
</style>
