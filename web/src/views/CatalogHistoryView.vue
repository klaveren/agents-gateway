<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import WideningConfirm from '@/components/WideningConfirm.vue'
import {
  BATCH_KIND_LABEL,
  BATCH_STATUS_LABEL,
  classifyFailure,
  HISTORY_PAGE_SIZE,
  itemLink,
  KIND_LABEL,
  listBatches,
  OP_LABEL,
  revertBatch,
  scopeHistory,
  SOURCE_LABEL,
  type IBatch,
  type IBatchPage,
  type IIssue,
  type IRevertResult,
  type IRevisionSummary,
  type IScopeHistory,
  type IWideningRef,
} from '@/lib/catalogHistory'
import { fullTime } from '@/lib/format'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * O HISTÓRICO DO CATÁLOGO (só admin): as revisões recentes de um escopo — tudo, só o global ou um projeto —, com o link
 * para a guia Histórico de cada item, e os lotes que aparecem nelas, com "Reverter lote".
 *
 * ⚖️ OS LOTES vêm da leitura própria (`GET /catalog/batches`), com o estado de cada um (aplicado, parcial, revertido),
 * o que ficou pendente e as ampliações aceitas. `?lote=<id>` destaca um (o link do importador depois de gravar).
 * ⛔ Reverter segue as travas do restaurar: 409 de ampliação pede a confirmação item por item; o item que mudou depois
 * do lote é pulado, e a pessoa escolhe, um a um, sobrescrever.
 */
const auth = useAuthStore()
const projects = useProjectsStore()
const route = useRoute()

/** `*` = tudo; `global`; ou o id de um projeto. */
const scope = ref<string>('*')
const page = ref(1)
const data = ref<IScopeHistory>()
const error = ref<string>()
const loading = ref(false)

const pages = computed(() => (data.value ? Math.max(1, Math.ceil(data.value.total / data.value.pageSize)) : 1))
const projectName = (id?: string) => (id ? (projects.list.find((project) => project.id === id)?.name ?? id) : 'Global')

/** Os lotes do escopo, do mais novo para o mais velho (página própria). */
const batchPage = ref<IBatchPage>()
const batchPageNo = ref(1)
const batchPages = computed(() => (batchPage.value ? Math.max(1, Math.ceil(batchPage.value.total / batchPage.value.pageSize)) : 1))
const batches = computed<IBatch[]>(() => batchPage.value?.batches ?? [])
const highlighted = computed(() => (typeof route.query.lote === 'string' ? route.query.lote : undefined))

/** O que o resumo do lote diz de onde parou e do que ficou pendente. */
const failedOf = (batch: IBatch) => batch.summary.failed as { ref: string; message: string } | undefined
const pendingOf = (batch: IBatch) => (Array.isArray(batch.summary.pending) ? (batch.summary.pending as string[]) : [])

let generation = 0
async function load() {
  const token = ++generation
  loading.value = true
  error.value = undefined
  const project = scope.value === '*' ? undefined : scope.value
  try {
    const [result, lots] = await Promise.all([scopeHistory(project, page.value, HISTORY_PAGE_SIZE), listBatches(project, batchPageNo.value, HISTORY_PAGE_SIZE)])
    if (token === generation) {
      data.value = result
      batchPage.value = lots
    }
  } catch (failure) {
    if (token === generation) error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    if (token === generation) loading.value = false
  }
}

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
})
watch(scope, () => {
  page.value = 1
  batchPageNo.value = 1
  void load()
})
watch([page, batchPageNo], () => void load())
watch(
  () => auth.isAdmin,
  (admin) => {
    if (admin) void load()
  },
  { immediate: true },
)

// --- Reverter lote ---------------------------------------------------------------------------------------------

const reverting = ref<IBatch>()
const asking = ref(false)
const busy = ref(false)
const widenings = ref<IWideningRef[]>()
const revertError = ref<string>()
const revertIssues = ref<IIssue[]>([])
const result = ref<IRevertResult>()
/** Os itens em conflito que a pessoa marcou para sobrescrever. */
const overwrite = ref<Set<string>>(new Set())

function startRevert(batch: IBatch) {
  reverting.value = batch
  widenings.value = undefined
  revertError.value = undefined
  revertIssues.value = []
  result.value = undefined
  overwrite.value = new Set()
  asking.value = true
}

async function revert(confirm?: string[]) {
  const batch = reverting.value
  if (!batch) return
  asking.value = false
  busy.value = true
  revertError.value = undefined
  revertIssues.value = []
  const chosen = [...overwrite.value]
  try {
    result.value = await revertBatch(batch.id, { ...(confirm ? { confirm } : {}), ...(chosen.length ? { overwrite: chosen } : {}) })
    widenings.value = undefined
    overwrite.value = new Set()
    await load()
  } catch (failure) {
    const reason = classifyFailure(failure)
    widenings.value = reason.type === 'widening' ? reason.widenings : undefined
    if (reason.type === 'conflict') revertError.value = 'Não deu para reverter: o lote já foi revertido, ou um item mudou no meio. A lista foi recarregada.'
    else if (reason.type === 'forbidden') revertError.value = 'O lote amplia acesso ao ser revertido, e só quem administra, entrando pela tela, pode aceitar.'
    else if (reason.type === 'invalid') revertIssues.value = reason.issues
    else if (reason.type === 'other') revertError.value = reason.message
    if (reason.type === 'conflict') await load()
  } finally {
    busy.value = false
  }
}

function toggleOverwrite(ref: string, on: boolean) {
  const next = new Set(overwrite.value)
  if (on) next.add(ref)
  else next.delete(ref)
  overwrite.value = next
}

const missingSecrets = computed(() => [...new Set((result.value?.reverted ?? []).flatMap((item) => item.missingSecrets))])
const link = (revision: IRevisionSummary) => itemLink(revision)
</script>

<template>
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra vê o histórico do catálogo.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">Histórico do catálogo</h1>
        <select v-model="scope" class="input ml-auto w-auto py-1.5 text-sm" aria-label="Escopo">
          <option value="*">Tudo</option>
          <option value="global">Global</option>
          <option v-for="project in projects.list" :key="project.id" :value="project.id">{{ project.name }}</option>
        </select>
      </header>
      <p class="text-xs text-zinc-500">Toda mudança em agentes, recursos, rules, docs, complementos, MCPs e permissões, da mais nova para a mais velha. Abra o item para ver o diff e restaurar.</p>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <p v-else-if="loading && !data" class="text-sm text-zinc-500">Carregando…</p>
      <p v-else-if="data && !data.revisions.length" class="text-sm text-zinc-500">Nenhuma revisão neste escopo.</p>

      <ul v-if="data?.revisions.length" class="divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-test="recent">
        <li v-for="revision in data.revisions" :key="revision.id" class="flex flex-col gap-0.5 px-3 py-2 text-sm">
          <span class="flex flex-wrap items-center gap-2">
            <span class="rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400 uppercase">{{ KIND_LABEL[revision.kind] ?? revision.kind }}</span>
            <RouterLink v-if="link(revision)" :to="link(revision)!" class="font-mono text-zinc-100 hover:underline">{{ revision.itemId }}</RouterLink>
            <span v-else class="font-mono text-zinc-100">{{ revision.itemId }}</span>
            <span class="text-zinc-300">{{ OP_LABEL[revision.op] ?? revision.op }}</span>
            <span class="font-mono text-xs text-zinc-500">rev {{ revision.revision }}</span>
            <span v-if="revision.widenings?.length" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300" :title="revision.widenings.join('\n')">
              ampliação aceita ({{ revision.widenings.length }})
            </span>
            <span class="ml-auto text-xs text-zinc-500">{{ fullTime(revision.at) }}</span>
          </span>
          <span class="text-xs text-zinc-400">
            {{ projectName(revision.projectId) }} · {{ revision.by }} · {{ SOURCE_LABEL[revision.source] ?? revision.source }}<template v-if="revision.note"> · {{ revision.note }}</template>
          </span>
        </li>
      </ul>
      <div v-if="pages > 1" class="flex items-center gap-2 text-xs text-zinc-500">
        <button type="button" class="btn btn-sm btn-ghost" :disabled="page <= 1" @click="page--">Mais novas</button>
        <span>Página {{ page }} de {{ pages }}</span>
        <button type="button" class="btn btn-sm btn-ghost" :disabled="page >= pages" @click="page++">Mais antigas</button>
      </div>

      <section class="flex flex-col gap-2">
        <h2 class="text-sm font-medium text-zinc-200">Lotes</h2>
        <p class="text-xs text-zinc-500">
          Os lotes (importação, reversão) do escopo, com o estado de cada um. Reverter grava um lote novo: cada item volta ao estado de antes, e o histórico guarda tudo.
        </p>
        <p v-if="!batches.length" class="text-xs text-zinc-500">Nenhum lote neste escopo.</p>
        <ul v-else class="divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-test="batches">
          <li
            v-for="batch in batches"
            :key="batch.id"
            class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            :class="batch.id === highlighted ? 'bg-emerald-500/10' : ''"
            :data-batch="batch.id"
          >
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-2">
                <code class="truncate text-zinc-200" :title="batch.id">{{ batch.id }}</code>
                <span
                  class="rounded-full px-2 py-0.5 text-[10px]"
                  :class="batch.status === 'applied' ? 'bg-emerald-500/15 text-emerald-300' : batch.status === 'partial' ? 'bg-rose-500/15 text-rose-300' : 'bg-zinc-700/50 text-zinc-300'"
                  data-test="batch-status"
                  >{{ BATCH_STATUS_LABEL[batch.status] ?? batch.status }}</span
                >
                <span class="text-xs text-zinc-400">{{ BATCH_KIND_LABEL[batch.kind] ?? batch.kind }}</span>
                <span v-if="batch.widenings.length" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300" :title="batch.widenings.map((item) => item.key).join('\n')">
                  {{ batch.widenings.length }} ampliação(ões) aceita(s)
                </span>
              </span>
              <span class="block truncate text-xs text-zinc-500">{{ fullTime(batch.at) }} · {{ batch.by }} · {{ batch.scope }} · {{ batch.items }} item(ns)</span>
              <span v-if="failedOf(batch)" class="block text-xs text-rose-300">
                Parou em <code>{{ failedOf(batch)!.ref }}</code>: {{ failedOf(batch)!.message }}<template v-if="pendingOf(batch).length"> · {{ pendingOf(batch).length }} pendente(s)</template>
              </span>
            </span>
            <button type="button" class="btn btn-sm btn-secondary" :disabled="busy || batch.status === 'reverted'" data-test="revert-batch" @click="startRevert(batch)">Reverter lote</button>
          </li>
        </ul>
        <div v-if="batchPages > 1" class="flex items-center gap-2 text-xs text-zinc-500">
          <button type="button" class="btn btn-sm btn-ghost" :disabled="batchPageNo <= 1" @click="batchPageNo--">Mais novos</button>
          <span>Página {{ batchPageNo }} de {{ batchPages }}</span>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="batchPageNo >= batchPages" @click="batchPageNo++">Mais antigos</button>
        </div>

        <template v-if="reverting && !asking">
          <WideningConfirm v-if="widenings" :widenings="widenings" action="Reverter com estas ampliações" :busy="busy" @confirm="revert" @cancel="widenings = undefined" />
          <p v-if="revertError" class="text-sm text-rose-300">{{ revertError }}</p>
          <div v-if="revertIssues.length" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            <ul class="list-disc pl-5">
              <li v-for="(issue, index) in revertIssues" :key="index">{{ issue.field ? `${issue.field}: ` : '' }}{{ issue.message }}</li>
            </ul>
          </div>
          <div v-if="result" class="flex flex-col gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm" data-test="revert-result">
            <p class="text-zinc-200">
              Lote {{ reverting.id }}: {{ result.reverted.length }} revertido(s), {{ result.unchanged.length }} já estava(m) como antes, {{ result.conflicts.length }} em conflito.
              <span class="text-zinc-500">Lote novo {{ result.batch.id }} · {{ result.batch.status === 'applied' ? 'aplicado' : result.batch.status === 'partial' ? 'parcial' : 'revertido' }}.</span>
            </p>
            <div v-if="result.failed" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">
              Parou em <code>{{ result.failed.ref }}</code>: {{ result.failed.message }}. Os seguintes não foram tocados.
              <ul v-if="result.failed.issues?.length" class="mt-1 list-disc pl-5">
                <li v-for="(issue, index) in result.failed.issues" :key="index">{{ issue.field }}: {{ issue.message }}</li>
              </ul>
            </div>
            <p v-if="missingSecrets.length" class="text-amber-200">Faltam segredos no cofre: <code>{{ missingSecrets.join(', ') }}</code>. Cadastre na tela do MCP.</p>
            <div v-if="result.conflicts.length" class="flex flex-col gap-1.5">
              <p class="text-xs text-zinc-400">Mudaram depois do lote e foram pulados. Marque os que devem voltar mesmo assim (perde o que mudou depois):</p>
              <label v-for="item in result.conflicts" :key="item.ref" class="flex items-center gap-2 text-sm text-zinc-200">
                <input type="checkbox" class="accent-amber-500" :checked="overwrite.has(item.ref)" @change="toggleOverwrite(item.ref, ($event.target as HTMLInputElement).checked)" />
                <code>{{ item.ref }}</code>
                <span class="text-xs text-zinc-500">hoje na rev {{ item.currentRevision }}, volta à rev {{ item.toRevision }}</span>
              </label>
              <div>
                <button type="button" class="btn btn-sm btn-secondary" :disabled="busy || !overwrite.size" @click="revert()">Reverter os marcados</button>
              </div>
            </div>
          </div>
        </template>
      </section>
    </section>

    <ConfirmDialog
      :open="asking"
      :title="`Reverter o lote ${reverting?.id ?? ''}?`"
      message="Cada item volta ao estado de antes do lote, num lote novo. O item que mudou depois do lote é pulado, e você decide um a um."
      action="Reverter"
      tone="neutral"
      :busy="busy"
      @confirm="revert()"
      @cancel="((asking = false), (reverting = undefined))"
    />
  </div>
</template>

<style scoped>
@reference '../style.css';

.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
</style>
