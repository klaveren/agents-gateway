<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { ApiError } from '@/lib/api'
import DiffView from '@/components/DiffView.vue'
import WideningConfirm from '@/components/WideningConfirm.vue'
import {
  classifyFailure,
  HISTORY_PAGE_SIZE,
  itemHistory,
  OP_LABEL,
  restoreRevision,
  revisionDiff,
  SOURCE_LABEL,
  type IIssue,
  type IItemHistory,
  type IRestoreResult,
  type IRevisionDiff,
  type IRevisionSummary,
  type IWideningRef,
  type TCatalogKind,
} from '@/lib/catalogHistory'
import { fullTime } from '@/lib/format'

/**
 * A GUIA HISTÓRICO de um item do catálogo: as revisões (da mais nova para a mais velha), o diff de uma delas contra a
 * anterior ou contra o atual, e "Restaurar esta versão".
 *
 * ⛔ AS TRAVAS DO SERVIDOR, na tela:
 * - `expectedRevision` = a última revisão que esta lista mostrou. 409 de conflito: avisa e recarrega;
 * - 409 de ampliação: a lista do que abre, uma caixa por item, todas obrigatórias, e reenvia com `confirm`;
 * - 422: os problemas, um por linha; no MCP, os segredos que faltam no cofre.
 * `readonly` (o membro do projeto, no MCP): só lê — restaurar é de quem administra.
 */
const props = defineProps<{ kind: TCatalogKind; id: string; readonly?: boolean }>()
const emit = defineEmits<{ restored: [result: IRestoreResult] }>()

const item = computed(() => ({ kind: props.kind, id: props.id }))
const history = ref<IItemHistory>()
const revisions = ref<IRevisionSummary[]>([])
const loadError = ref<string>()
const loading = ref(false)
const selected = ref<number>()
const compare = ref<'previous' | 'current'>('previous')
const diff = ref<IRevisionDiff>()
const diffError = ref<string>()

const confirming = ref(false)
const busy = ref(false)
const widenings = ref<IWideningRef[]>()
const conflict = ref<string>()
const issues = ref<IIssue[]>([])
const failure = ref<string>()
const done = ref<IRestoreResult>()

/** A última revisão que a tela viu: é a que vai em `expectedRevision`. */
const latest = computed(() => revisions.value[0]?.revision ?? 0)
const chosen = computed(() => revisions.value.find((revision) => revision.revision === selected.value))
/** A revisão escolhida já é o estado atual: restaurar não mudaria nada. */
const isCurrent = computed(() => !!chosen.value && chosen.value.revision === latest.value && history.value?.current.hash === chosen.value.hash)

let generation = 0
async function load(keepSelection = false) {
  const token = ++generation
  loading.value = true
  loadError.value = undefined
  try {
    const page = await itemHistory(item.value)
    if (token !== generation) return
    history.value = page
    revisions.value = page.revisions
    if (!keepSelection || !revisions.value.some((revision) => revision.revision === selected.value)) selected.value = revisions.value[0]?.revision
    await loadDiff()
  } catch (error) {
    if (token !== generation) return
    // 404: o item nunca foi gravado (o complemento que ninguém escreveu) — ou o leitor não pode vê-lo.
    if (error instanceof ApiError && error.status === 404) {
      history.value = { kind: props.kind, itemId: props.id, current: { exists: false }, revisions: [], total: 0, page: 1, pageSize: HISTORY_PAGE_SIZE }
      revisions.value = []
    } else loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (token === generation) loading.value = false
  }
}

async function more() {
  if (!history.value) return
  const next = await itemHistory(item.value, Math.floor(revisions.value.length / history.value.pageSize) + 1, history.value.pageSize).catch((error) => {
    loadError.value = error instanceof Error ? error.message : String(error)
    return undefined
  })
  if (!next) return
  const seen = new Set(revisions.value.map((revision) => revision.revision))
  revisions.value = [...revisions.value, ...next.revisions.filter((revision) => !seen.has(revision.revision))]
  history.value = { ...history.value, total: next.total }
}

let diffGeneration = 0
async function loadDiff() {
  const token = ++diffGeneration
  diff.value = undefined
  diffError.value = undefined
  const revision = selected.value
  if (revision === undefined) return
  try {
    const result = compare.value === 'previous' ? await revisionDiff(item.value, revision - 1, revision) : await revisionDiff(item.value, revision, 'current')
    if (token === diffGeneration) diff.value = result
  } catch (error) {
    if (token === diffGeneration) diffError.value = error instanceof Error ? error.message : String(error)
  }
}

function resetWrite() {
  widenings.value = undefined
  conflict.value = undefined
  issues.value = []
  failure.value = undefined
  done.value = undefined
}

watch(
  item,
  () => {
    resetWrite()
    selected.value = undefined
    void load()
  },
  { immediate: true },
)
watch([selected, compare], () => void loadDiff())

function pick(revision: number) {
  if (selected.value === revision) return
  selected.value = revision
  resetWrite()
}

async function restore(confirm?: string[]) {
  const revision = selected.value
  if (revision === undefined) return
  confirming.value = false
  busy.value = true
  resetWrite()
  try {
    const result = await restoreRevision(item.value, revision, latest.value, confirm)
    done.value = result
    await load(true)
    emit('restored', result)
  } catch (error) {
    const reason = classifyFailure(error)
    if (reason.type === 'widening') widenings.value = reason.widenings
    else if (reason.type === 'conflict') {
      conflict.value = 'Alguém mudou este item depois que você abriu o histórico. A lista foi recarregada: confira o diff e tente de novo.'
      await load(true)
    } else if (reason.type === 'invalid') issues.value = reason.issues
    else if (reason.type === 'forbidden') failure.value = 'A versão amplia acesso, e só quem administra, entrando pela tela, pode aceitar.'
    else failure.value = reason.message
  } finally {
    busy.value = false
  }
}

const sideLabel = (side: IRevisionDiff['from']) => (side.revision === 'current' ? 'atual' : side.revision === 0 ? 'antes de existir' : `rev ${side.revision}`)
</script>

<template>
  <section class="flex flex-col gap-4" data-test="history-panel">
    <p v-if="loadError" class="text-sm text-rose-300">{{ loadError }}</p>
    <p v-else-if="loading && !history" class="text-sm text-zinc-500">Carregando o histórico…</p>
    <p v-else-if="history && !revisions.length" class="text-sm text-zinc-500">Nenhuma revisão gravada ainda.</p>

    <template v-if="revisions.length">
      <p v-if="history && history.current.hash !== revisions[0]?.hash" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-test="drift">
        O item atual difere da última revisão: mudou por fora do histórico. Restaurar dá conflito até o servidor registrar essa mudança (ele grava ao reiniciar).
      </p>
      <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-test="revisions">
        <li v-for="revision in revisions" :key="revision.revision">
          <button
            type="button"
            class="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm"
            :class="revision.revision === selected ? 'bg-emerald-500/10' : 'hover:bg-zinc-800/50'"
            :aria-pressed="revision.revision === selected"
            :data-revision="revision.revision"
            @click="pick(revision.revision)"
          >
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-mono text-xs text-zinc-500">rev {{ revision.revision }}</span>
              <span class="font-medium text-zinc-100">{{ OP_LABEL[revision.op] ?? revision.op }}</span>
              <span v-if="revision.widenings?.length" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300" :title="revision.widenings.join('\n')" data-test="widening-badge">
                ampliação aceita ({{ revision.widenings.length }})
              </span>
              <span v-if="revision.batchId" class="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400" :title="`Lote ${revision.batchId}`">lote</span>
              <span v-if="revision.revision === latest" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">última</span>
              <span class="ml-auto text-xs text-zinc-500">{{ fullTime(revision.at) }}</span>
            </span>
            <span class="text-xs text-zinc-400">{{ revision.by }} · {{ SOURCE_LABEL[revision.source] ?? revision.source }}<template v-if="revision.note"> · {{ revision.note }}</template></span>
          </button>
        </li>
      </ul>
      <button v-if="history && revisions.length < history.total" type="button" class="btn btn-sm btn-ghost self-start" @click="more">Mostrar mais antigas</button>

      <section v-if="chosen" class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-medium text-zinc-200">Revisão {{ chosen.revision }}</h3>
          <div class="flex gap-1 text-xs" role="group" aria-label="Comparar com">
            <button type="button" class="btn btn-sm" :class="compare === 'previous' ? 'btn-secondary' : 'btn-ghost'" data-test="compare-previous" @click="compare = 'previous'">Contra a anterior</button>
            <button type="button" class="btn btn-sm" :class="compare === 'current' ? 'btn-secondary' : 'btn-ghost'" data-test="compare-current" @click="compare = 'current'">Contra o atual</button>
          </div>
          <button
            v-if="!readonly && !isCurrent"
            type="button"
            class="btn btn-sm btn-primary ml-auto"
            :disabled="busy"
            data-test="restore"
            @click="confirming = true"
          >
            Restaurar esta versão
          </button>
          <span v-else-if="!readonly" class="ml-auto text-xs text-zinc-500">É a versão atual.</span>
        </div>

        <p v-if="diffError" class="text-sm text-rose-300">{{ diffError }}</p>
        <template v-else-if="diff">
          <p class="text-xs text-zinc-500">
            De {{ sideLabel(diff.from) }} para {{ sideLabel(diff.to) }}:
            <span class="text-emerald-300">+{{ diff.added }}</span> /
            <span class="text-rose-300">−{{ diff.removed }}</span> linha(s)
          </p>
          <p v-if="diff.equal" class="text-sm text-zinc-500">Sem diferença.</p>
          <DiffView v-else :hunks="diff.hunks" />
        </template>

        <p v-if="conflict" class="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200" data-test="conflict">{{ conflict }}</p>
        <WideningConfirm v-if="widenings" :widenings="widenings" action="Restaurar com estas ampliações" :busy="busy" @confirm="restore" @cancel="widenings = undefined" />
        <div v-if="issues.length" class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200" data-test="issues">
          <p class="font-medium">Esta versão não passa nas regras de hoje:</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="(issue, index) in issues" :key="index"><code v-if="issue.field" class="text-rose-100">{{ issue.field }}</code><template v-if="issue.field">: </template>{{ issue.message }}</li>
          </ul>
        </div>
        <p v-if="failure" class="text-sm text-rose-300">{{ failure }}</p>
        <div v-if="done" class="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200" data-test="restored">
          <p>{{ done.unchanged ? 'Já era a versão atual: nada mudou.' : `Restaurado da rev ${done.restoredFrom}${done.revision ? ` (nova rev ${done.revision.revision})` : ''}.` }}</p>
          <p v-if="done.alsoChanged.length" class="text-xs text-emerald-300/80">Mudaram junto: {{ done.alsoChanged.map((item) => `${item.kind}/${item.itemId}`).join(', ') }}.</p>
          <p v-if="done.missingSecrets.length" class="mt-1 text-amber-200" data-test="missing-secrets">
            Faltam segredos no cofre: <code>{{ done.missingSecrets.join(', ') }}</code>. Cadastre na tela do MCP antes de usar.
          </p>
        </div>
        <p v-if="readonly" class="text-xs text-zinc-500">Só quem administra restaura versões.</p>
      </section>
    </template>

    <ConfirmDialog
      :open="confirming"
      :title="`Restaurar a revisão ${selected}?`"
      :message="
        chosen?.op === 'delete'
          ? 'Nesta revisão o item não existia: restaurar apaga o item. O histórico guarda tudo.'
          : 'Grava uma revisão nova com o conteúdo desta. O que veio depois continua no histórico.'
      "
      action="Restaurar"
      tone="neutral"
      :busy="busy"
      @confirm="restore()"
      @cancel="confirming = false"
    />
  </section>
</template>
