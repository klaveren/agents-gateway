<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ApiError } from '@/lib/api'
import { shortTime, fullTime } from '@/lib/format'
import {
  ACTION_LABEL,
  authorLabel,
  contextKey,
  filterContexts,
  type ILedgerLine,
  LEDGER_LINE_TYPES,
  lineText,
  snapshotText,
  type TLedgerLineInput,
  WARNING_BADGE,
} from '@/lib/ledger'
import { renderMarkdown } from '@/lib/markdown'
import { useResource } from '@/composables/useResource'
import { useLedgerStore } from '@/stores/ledger'
import ConfirmDialog from './ConfirmDialog.vue'
import ListPager from './ListPager.vue'
import { usePaged } from '@/composables/usePaged'

/**
 * A guia MEMÓRIA de um agente: o ledger dele — o que aprendeu de COMO AGIR, por tema (gatilho, linhas, playbook). O
 * agente escreve o próprio pela ferramenta `ledger_write`; aqui quem administra lê, corrige e exporta, e cada mudança
 * vira revisão com o admin como autor. ⚠️ Mora DENTRO do formulário do agente: nada aqui é `<form>` nem submete com
 * Enter, e quem valida é o servidor (a mesma regra da ferramenta).
 */
const props = defineProps<{ agentId: string }>()
const store = useLedgerStore()

const { data: index, error: loadError, refresh } = useResource(store.indexes, () => props.agentId)
const contexts = computed(() => index.value?.contexts ?? [])
const ledgerWarnings = computed(() => (index.value?.warnings ?? []).filter((warning) => !warning.topic || warning.code === 'similar-topics'))

const filter = ref('')
const shown = computed(() => filterContexts(contexts.value, filter.value))
const contextPage = usePaged(shown)

/** O contexto aberto: `''` = um novo; `undefined` = nenhum. */
const open = ref<string>()
const editing = computed(() => open.value !== undefined)
const creating = computed(() => open.value === '')
const { data: context } = useResource(store.contexts, () => (open.value ? contextKey(props.agentId, open.value) : undefined))

const history = ref(false)
const { data: revisions } = useResource(store.revisions, () => (open.value && history.value ? contextKey(props.agentId, open.value) : undefined))
const linePage = usePaged(
  computed(() => context.value?.lines ?? []),
  { by: (line) => line.id },
)
const revisionPage = usePaged(computed(() => revisions.value ?? []))

const draft = ref({ topic: '', trigger: '', playbook: '' })
const preview = ref(false)
const lineDraft = ref<TLedgerLineInput>(blankLine())
/** A linha em edição (o id) e o rascunho dela. */
const editingLine = ref<number>()
const editDraft = ref<TLedgerLineInput>(blankLine())

const busy = ref(false)
const error = ref<string>()
const issues = ref<Record<string, string[]>>({})
const notice = ref<string>()
const confirm = ref<{ kind: 'context' } | { kind: 'line'; line: ILedgerLine }>()

/** A busca nas linhas (no servidor); `undefined` = nenhuma feita. */
const found = ref<{ query: string; lines: Array<ILedgerLine & { topic: string }> }>()
const foundPage = usePaged(computed(() => found.value?.lines ?? []))

function blankLine(): TLedgerLineInput {
  return { type: 'APRENDIZADO', trigger: '', learning: '', ref: '' }
}

watch(
  () => props.agentId,
  () => {
    open.value = undefined
    found.value = undefined
  },
)
// O contexto aberto chegou (ou mudou por uma gravação): o rascunho segue o que está gravado.
watch(context, (current) => {
  if (current && !creating.value) draft.value = { topic: current.topic, trigger: current.trigger, playbook: current.playbook }
})

function describe(failure: unknown): string {
  if (failure instanceof ApiError && failure.status === 422) {
    const items = Array.isArray(failure.details) ? (failure.details as Array<{ field?: string; message?: string }>) : []
    return items.map((item) => (item.field ? `${FIELD[item.field] ?? item.field}: ${item.message}` : item.message)).join('; ') || failure.message
  }
  return failure instanceof Error ? failure.message : String(failure)
}
const FIELD: Record<string, string> = { topic: 'tema', trigger: 'gatilho', playbook: 'playbook', type: 'tipo', lineTrigger: 'situação', learning: 'aprendizado', ref: 'ref', date: 'data' }

async function run(work: () => Promise<unknown>) {
  busy.value = true
  error.value = undefined
  issues.value = {}
  notice.value = undefined
  try {
    await work()
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) issues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

function openContext(topic: string) {
  error.value = undefined
  issues.value = {}
  notice.value = undefined
  editingLine.value = undefined
  history.value = false
  preview.value = false
  lineDraft.value = blankLine()
  if (open.value === topic) return (open.value = undefined)
  open.value = topic
  draft.value = topic ? { ...draft.value, topic } : { topic: '', trigger: '', playbook: '' }
}

const create = () =>
  run(async () => {
    const result = await store.create(props.agentId, { topic: draft.value.topic, trigger: draft.value.trigger, ...(draft.value.playbook.trim() ? { playbook: draft.value.playbook } : {}) })
    open.value = result.topic
  })

const saveContext = () =>
  run(async () => {
    if (!context.value) return
    const change = {
      ...(draft.value.trigger !== context.value.trigger ? { trigger: draft.value.trigger } : {}),
      ...(draft.value.playbook !== context.value.playbook ? { playbook: draft.value.playbook } : {}),
    }
    if (!Object.keys(change).length) return (notice.value = 'Nada mudou.')
    await store.update(props.agentId, context.value.topic, change)
    notice.value = 'Salvo.'
  })
const contextChanged = computed(() => !!context.value && (draft.value.trigger !== context.value.trigger || draft.value.playbook !== context.value.playbook))

const addLine = () =>
  run(async () => {
    if (!context.value) return
    const { ref: reference, date, ...line } = lineDraft.value
    await store.addLine(props.agentId, context.value.topic, { ...line, ...(reference?.trim() ? { ref: reference } : {}), ...(date?.trim() ? { date } : {}) })
    lineDraft.value = blankLine()
  })

function editLine(line: ILedgerLine) {
  editingLine.value = line.id
  editDraft.value = { type: line.type, trigger: line.trigger, learning: line.learning, ref: line.ref, date: line.date }
}

const saveLine = () =>
  run(async () => {
    if (!context.value || editingLine.value === undefined) return
    await store.updateLine(props.agentId, context.value.topic, editingLine.value, editDraft.value)
    editingLine.value = undefined
  })

async function confirmed() {
  const target = confirm.value
  confirm.value = undefined
  if (!target || !context.value) return
  const topic = context.value.topic
  await run(async () => {
    if (target.kind === 'line') await store.removeLine(props.agentId, topic, target.line.id)
    else {
      await store.remove(props.agentId, topic)
      open.value = undefined
    }
  })
}

const searchLines = () =>
  run(async () => {
    const query = filter.value.trim()
    if (!query) return (found.value = undefined)
    found.value = { query, lines: (await store.search(props.agentId, query)).lines }
  })

const exportLedger = () => run(() => store.download(props.agentId))

const typeLabel = (type: string) => LEDGER_LINE_TYPES.find((item) => item.id === type)?.label ?? type
const lineWarning = (line: ILedgerLine) => context.value?.warnings.find((warning) => warning.lineId === line.id)?.message
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-xs text-zinc-500">
      O que o agente aprendeu de <strong class="font-medium text-zinc-300">como agir</strong>, por tema. O índice (tema → gatilho) vai no prompt de toda conversa; o
      contexto inteiro ele carrega com <code>ledger_read</code> quando o gatilho casa, e escreve o próprio com <code>ledger_write</code>. Suas mudanças ficam no
      histórico com o seu nome.
    </p>
    <p v-if="loadError" class="text-sm text-rose-300">{{ describe(loadError) }}</p>

    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="filter"
        class="input min-w-0 flex-1 text-sm"
        placeholder="Filtrar por tema ou gatilho (Enter busca também nas linhas)"
        data-test="ledger-filter"
        @keydown.enter.prevent="searchLines"
      />
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="searchLines">Buscar nas linhas</button>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="refresh">Atualizar</button>
      <button type="button" class="btn btn-secondary" :disabled="busy || !contexts.length" data-test="ledger-export" @click="exportLedger">Exportar</button>
    </div>
    <p v-if="index" class="text-xs text-zinc-500">
      {{ index.contexts.length }} contexto(s), {{ index.lineCount }} linha(s) — a meta é ficar abaixo de ~40 linhas, só aprendizado.
    </p>

    <ul v-if="ledgerWarnings.length" class="flex flex-col gap-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-test="ledger-warnings">
      <li v-for="warning in ledgerWarnings" :key="warning.message">⚠️ {{ warning.message }}</li>
    </ul>

    <div v-if="found" class="flex flex-col gap-1 rounded-xl border border-zinc-800 p-3" data-test="ledger-found">
      <div class="flex items-center gap-2 text-xs text-zinc-400">
        <span>Linhas com "{{ found.query }}": {{ found.lines.length }}</span>
        <button type="button" class="ml-auto underline hover:text-zinc-200" @click="found = undefined">fechar</button>
      </div>
      <button
        v-for="line in foundPage.items.value"
        :key="line.id"
        type="button"
        class="truncate text-left font-mono text-[12px] text-zinc-300 hover:text-zinc-100"
        @click="openContext(line.topic)"
      >
        {{ line.topic }} #{{ line.id }} {{ lineText(line) }}
      </button>
      <ListPager v-model="foundPage.page.value" :pages="foundPage.pages.value" :total="foundPage.total.value" :size="foundPage.size" />
    </div>

    <ul class="divide-y divide-zinc-800 rounded-xl border border-zinc-800" data-test="ledger-contexts">
      <li v-for="item in contextPage.items.value" :key="item.topic">
        <button type="button" class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-800/40" @click="openContext(item.topic)">
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-[13px] text-zinc-200">{{ item.topic }}</span>
            <span class="block truncate text-xs text-zinc-400">{{ item.trigger }}</span>
            <span class="block truncate text-xs text-zinc-500">
              {{ item.lineCount }} linha(s)<template v-if="item.hasPlaybook"> · playbook</template> · alterado {{ shortTime(item.updatedAt) }} por {{ authorLabel(item.updatedBy) }}
            </span>
          </span>
          <span
            v-for="warning in item.warnings"
            :key="warning.message"
            class="inline-block shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
            :title="warning.message"
            data-test="ledger-badge"
          >
            {{ WARNING_BADGE[warning.code] }}
          </span>
          <span class="text-xs text-zinc-500">{{ open === item.topic ? '▴' : '▾' }}</span>
        </button>
      </li>
      <li v-if="index && !contexts.length" class="px-3 py-3 text-xs text-zinc-500">Nenhum contexto ainda: o agente cria os dele com <code>ledger_write</code>.</li>
      <li v-else-if="index && !shown.length" class="px-3 py-3 text-xs text-zinc-500">Nenhum contexto com "{{ filter }}".</li>
    </ul>
    <ListPager v-model="contextPage.page.value" :pages="contextPage.pages.value" :total="contextPage.total.value" :size="contextPage.size" />
    <button v-if="!creating" type="button" class="btn btn-secondary self-start" @click="openContext('')">+ Novo contexto</button>

    <div v-if="editing" class="flex flex-col gap-3 rounded-xl border border-zinc-800 p-3" data-test="ledger-context">
      <h3 class="text-sm font-medium text-zinc-200">{{ creating ? 'Novo contexto' : `Contexto ${open}` }}</h3>

      <label v-if="creating" class="field">
        Tema
        <input v-model="draft.topic" class="input font-mono" placeholder="build-oom" data-test="ledger-topic" @keydown.enter.prevent />
        <small class="hint">Vira slug (minúsculas e hífen). Antes de criar, confira se o tema já existe na lista.</small>
        <small v-for="m in issues.topic" :key="m" class="error">{{ m }}</small>
      </label>
      <label class="field">
        Gatilho — quando carregar
        <input v-model="draft.trigger" class="input text-sm" placeholder="quando o build estourar memória no CI" data-test="ledger-trigger" @keydown.enter.prevent />
        <small class="hint">Uma linha, com a situação que dispara. Sem gatilho bom o contexto é inalcançável.</small>
        <small v-for="m in issues.trigger" :key="m" class="error">{{ m }}</small>
      </label>
      <div class="field">
        <span class="flex items-center gap-2">
          Playbook (markdown, opcional)
          <button type="button" class="ml-auto text-xs underline hover:text-zinc-200" @click="preview = !preview">{{ preview ? 'Editar' : 'Pré-visualizar' }}</button>
        </span>
        <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
        <div v-if="preview" class="prose-agent rounded-lg border border-zinc-800 p-3 text-sm" data-test="ledger-preview" v-html="renderMarkdown(draft.playbook || '_(vazio)_')" />
        <textarea v-else v-model="draft.playbook" rows="6" class="input font-mono text-[13px]" placeholder="Árvore, diagrama, contrato — o que fatiar em linhas destruiria." />
        <small v-for="m in issues.playbook" :key="m" class="error">{{ m }}</small>
      </div>
      <div class="flex gap-2">
        <button v-if="creating" type="button" class="btn btn-primary" :disabled="busy" data-test="ledger-create" @click="create">Criar contexto</button>
        <button v-else type="button" class="btn btn-primary" :disabled="busy || !contextChanged" data-test="ledger-save" @click="saveContext">Salvar gatilho e playbook</button>
        <button type="button" class="btn btn-secondary" @click="open = undefined">Fechar</button>
        <button v-if="!creating && context" type="button" class="btn btn-danger ml-auto" :disabled="busy" @click="confirm = { kind: 'context' }">Excluir contexto</button>
      </div>

      <template v-if="!creating && context">
        <ul v-if="context.warnings.length" class="flex flex-col gap-1 text-xs text-amber-200">
          <li v-for="warning in context.warnings" :key="warning.message">⚠️ {{ warning.message }}</li>
        </ul>

        <h4 class="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-400">Linhas</h4>
        <ul class="flex flex-col divide-y divide-zinc-800 rounded-lg border border-zinc-800" data-test="ledger-lines">
          <li v-for="line in linePage.items.value" :key="line.id" class="flex flex-col gap-2 px-3 py-2">
            <div v-if="editingLine !== line.id" class="flex items-start gap-2">
              <span class="min-w-0 flex-1">
                <span class="block font-mono text-[12px] text-zinc-200">#{{ line.id }} {{ lineText(line) }}</span>
                <span class="block text-xs text-zinc-500">{{ typeLabel(line.type) }} · {{ authorLabel(line.updatedBy) }} em {{ fullTime(line.updatedAt) }}</span>
                <span v-if="lineWarning(line)" class="block text-xs text-amber-200">⚠️ {{ lineWarning(line) }}</span>
              </span>
              <button type="button" class="text-xs underline hover:text-zinc-200" @click="editLine(line)">editar</button>
              <button type="button" class="text-xs text-rose-300 underline hover:text-rose-200" @click="confirm = { kind: 'line', line }">apagar</button>
            </div>
            <div v-else class="grid gap-2 sm:grid-cols-[10rem_1fr]" data-test="ledger-line-edit">
              <select v-model="editDraft.type" class="input text-sm">
                <option v-for="type in LEDGER_LINE_TYPES" :key="type.id" :value="type.id">{{ type.label }}</option>
              </select>
              <input v-model="editDraft.trigger" class="input text-sm" placeholder="situação" @keydown.enter.prevent />
              <input v-model="editDraft.date" class="input font-mono text-sm" placeholder="AAAA-MM-DD" @keydown.enter.prevent />
              <input v-model="editDraft.learning" class="input text-sm" placeholder="aprendizado em uma frase" @keydown.enter.prevent />
              <span />
              <input v-model="editDraft.ref" class="input text-sm" placeholder="ação/ref (opcional)" @keydown.enter.prevent />
              <span class="flex gap-2 sm:col-span-2">
                <button type="button" class="btn btn-primary" :disabled="busy" data-test="ledger-line-save" @click="saveLine">Salvar linha</button>
                <button type="button" class="btn btn-secondary" @click="editingLine = undefined">Cancelar</button>
              </span>
            </div>
          </li>
          <li v-if="!context.lines.length" class="px-3 py-2 text-xs text-zinc-500">Sem linhas.</li>
        </ul>
        <ListPager v-model="linePage.page.value" :pages="linePage.pages.value" :total="linePage.total.value" :size="linePage.size" />

        <div class="grid gap-2 sm:grid-cols-[10rem_1fr]" data-test="ledger-line-new">
          <select v-model="lineDraft.type" class="input text-sm" :title="LEDGER_LINE_TYPES.find((type) => type.id === lineDraft.type)?.hint">
            <option v-for="type in LEDGER_LINE_TYPES" :key="type.id" :value="type.id">{{ type.label }}</option>
          </select>
          <input v-model="lineDraft.trigger" class="input text-sm" placeholder="situação: quando vale" data-test="ledger-line-trigger" @keydown.enter.prevent />
          <input v-model="lineDraft.date" class="input font-mono text-sm" placeholder="data (hoje)" @keydown.enter.prevent />
          <input v-model="lineDraft.learning" class="input text-sm" placeholder="aprendizado em uma frase" data-test="ledger-line-learning" @keydown.enter.prevent />
          <span />
          <input v-model="lineDraft.ref" class="input text-sm" placeholder="ação/ref (opcional)" @keydown.enter.prevent />
          <small v-for="m in [...(issues.type ?? []), ...(issues.lineTrigger ?? []), ...(issues.learning ?? []), ...(issues.ref ?? []), ...(issues.date ?? [])]" :key="m" class="error sm:col-span-2">
            {{ m }}
          </small>
          <button type="button" class="btn btn-secondary self-start sm:col-span-2 sm:justify-self-start" :disabled="busy" data-test="ledger-line-add" @click="addLine">+ Acrescentar linha</button>
        </div>

        <button type="button" class="self-start text-xs underline hover:text-zinc-200" data-test="ledger-history-toggle" @click="history = !history">
          {{ history ? 'Esconder o histórico' : 'Ver o histórico' }}
        </button>
        <ol v-if="history" class="flex flex-col gap-2" data-test="ledger-history">
          <li v-for="revision in revisionPage.items.value" :key="revision.id" class="rounded-lg border border-zinc-800 px-3 py-2 text-xs">
            <p class="text-zinc-300">
              <strong class="font-medium">{{ authorLabel(revision.by) }}</strong> {{ ACTION_LABEL[revision.action] }}<template v-if="revision.lineId"> #{{ revision.lineId }}</template>
              <span class="text-zinc-500"> · {{ fullTime(revision.at) }}</span>
            </p>
            <pre v-if="revision.before" class="mt-1 whitespace-pre-wrap text-rose-300/80">− {{ snapshotText(revision.before) }}</pre>
            <pre v-if="revision.after" class="mt-1 whitespace-pre-wrap text-emerald-300/80">+ {{ snapshotText(revision.after) }}</pre>
          </li>
          <li v-if="revisions && !revisions.length" class="text-xs text-zinc-500">Sem revisões.</li>
        </ol>
        <ListPager v-model="revisionPage.page.value" :pages="revisionPage.pages.value" :total="revisionPage.total.value" :size="revisionPage.size" />
      </template>
    </div>

    <p v-if="notice" class="text-xs text-emerald-300">{{ notice }}</p>
    <p v-if="error" class="text-sm text-rose-300" data-test="ledger-error">{{ error }}</p>

    <ConfirmDialog
      :open="!!confirm"
      :title="confirm?.kind === 'line' ? `Apagar a linha #${confirm.line.id}?` : `Excluir o contexto ${open}?`"
      :message="confirm?.kind === 'line' ? 'A linha sai do ledger; o histórico guarda o texto.' : 'O contexto sai com todas as linhas e some do índice do prompt. O histórico guarda o que saiu.'"
      :busy="busy"
      @confirm="confirmed"
      @cancel="confirm = undefined"
    />
  </div>
</template>
