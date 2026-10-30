<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import { api, ApiError } from '@/lib/api'
import { sizeHint } from '@/lib/format'
import { pendingDraft } from '@/lib/builder'
import { GLOBAL_SCOPE, rulesTokens, scopeToProjectId } from '@/lib/guidance'
import type { IRule } from '@/lib/types'

/**
 * As RULES de um escopo: as globais ou as de um projeto. Uma por registro, numeradas como entram no prompt.
 * `showGlobals`: no projeto, as globais aparecem antes, só para ler — é a ordem da conversa. `readonly`: só a lista
 * (o Ambiente mostra; quem edita é a página Rules). Emite `weight`: os tokens das rules ligadas que toda conversa do
 * escopo leva (as globais inclusive, quando mostradas).
 */
const props = defineProps<{ scope: string; showGlobals?: boolean; readonly?: boolean }>()
const emit = defineEmits<{ weight: [tokens: number] }>()

const rules = ref<IRule[]>([])
const globals = ref<IRule[]>([])
const loading = ref(false)
const error = ref<string>()
const draft = ref({ title: '', body: '' })
const draftIssues = ref<Record<string, string[]>>({})
const draftNote = ref<string>()
const editing = ref<string>()
const edit = ref({ title: '', body: '' })
const removing = ref<IRule>()
const busy = ref(false)

/** O número com que cada rule ligada entra no prompt: as globais primeiro, depois as do escopo. */
const numberOf = computed(() => {
  const numbers = new Map<string, number>()
  let next = 1
  for (const rule of [...(props.showGlobals ? globals.value : []), ...rules.value]) if (rule.enabled) numbers.set(rule.id, next++)
  return numbers
})

watch(() => props.scope, load, { immediate: true })
watch(
  () => [rules.value, globals.value] as const,
  () => emit('weight', rulesTokens([...(props.showGlobals ? globals.value : []), ...rules.value])),
  { deep: true },
)

async function load() {
  loading.value = true
  error.value = undefined
  editing.value = undefined
  applyDraft()
  try {
    const [own, global] = await Promise.all([
      api<IRule[]>('/rules', { query: { project: props.scope } }),
      props.showGlobals && props.scope !== GLOBAL_SCOPE ? api<IRule[]>('/rules', { query: { project: GLOBAL_SCOPE } }) : Promise.resolve([]),
    ])
    rules.value = own
    globals.value = global
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    loading.value = false
  }
}

/** O rascunho do construtor ("Abrir no editor"): vai para o formulário de rule nova deste escopo, SEM salvar. */
function applyDraft() {
  const pending = pendingDraft.value
  if (pending?.kind !== 'rule' || (pending.projectId ?? GLOBAL_SCOPE) !== props.scope) return
  pendingDraft.value = undefined
  draft.value = { title: pending.title, body: pending.body }
  draftNote.value = 'Rascunho do construtor aplicado: revise e adicione.'
}

async function run(work: () => Promise<unknown>) {
  busy.value = true
  error.value = undefined
  try {
    await work()
    await load()
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

async function add() {
  draftIssues.value = {}
  busy.value = true
  error.value = undefined
  try {
    await api('/rules', { method: 'POST', body: { ...draft.value, projectId: scopeToProjectId(props.scope) } })
    draft.value = { title: '', body: '' }
    draftNote.value = undefined
    await load()
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 422) draftIssues.value = failure.fieldIssues
    error.value = describe(failure)
  } finally {
    busy.value = false
  }
}

function startEdit(rule: IRule) {
  editing.value = rule.id
  edit.value = { title: rule.title, body: rule.body }
}

const saveEdit = (rule: IRule) =>
  run(async () => {
    await api(`/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: edit.value })
    editing.value = undefined
  })
const toggle = (rule: IRule) => run(() => api(`/rules/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: { enabled: !rule.enabled } }))
const move = (rule: IRule, direction: 'up' | 'down') => run(() => api(`/rules/${encodeURIComponent(rule.id)}/move`, { method: 'POST', body: { direction } }))

async function confirmRemove() {
  const target = removing.value
  if (!target) return
  await run(() => api(`/rules/${encodeURIComponent(target.id)}`, { method: 'DELETE' }))
  removing.value = undefined
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>

    <ol class="flex flex-col gap-2">
      <li v-for="rule in showGlobals ? globals : []" :key="rule.id" class="rounded-xl border border-zinc-800/60 p-3 opacity-60" title="Regra global: vale em todos os projetos">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{{ numberOf.get(rule.id) ? `Regra ${numberOf.get(rule.id)}` : '—' }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{{ rule.title }}<span v-if="!rule.enabled" class="ml-2 text-xs font-normal text-zinc-500">desligada</span></p>
            <p class="mt-0.5 text-sm whitespace-pre-line text-zinc-400">{{ rule.body }}</p>
          </div>
          <span class="shrink-0 rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">global</span>
        </div>
      </li>
      <li v-for="(rule, index) in rules" :key="rule.id" class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3" :class="rule.enabled ? '' : 'opacity-60'">
        <form v-if="editing === rule.id" class="flex flex-col gap-2" @submit.prevent="saveEdit(rule)">
          <input v-model="edit.title" required maxlength="120" class="input text-sm font-medium" aria-label="Título" />
          <textarea v-model="edit.body" required rows="3" class="input text-sm" aria-label="Regra" />
          <small v-if="edit.body" class="hint">{{ sizeHint(edit.body, 'a cada turno') }}</small>
          <div class="flex gap-2">
            <button type="submit" :disabled="busy" class="btn btn-sm btn-primary">Salvar</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="editing = undefined">Cancelar</button>
          </div>
        </form>
        <div v-else class="flex items-start gap-3">
          <span class="mt-0.5 shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">{{ numberOf.get(rule.id) ? `Regra ${numberOf.get(rule.id)}` : '—' }}</span>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-medium">{{ rule.title }}<span v-if="!rule.enabled" class="ml-2 text-xs font-normal text-zinc-500">desligada</span></p>
            <p class="mt-0.5 text-sm whitespace-pre-line text-zinc-400">{{ rule.body }}</p>
          </div>
          <div v-if="!readonly" class="flex shrink-0 items-center gap-0.5 text-zinc-400">
            <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="busy || index === 0" title="Subir" @click="move(rule, 'up')">↑</button>
            <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="busy || index === rules.length - 1" title="Descer" @click="move(rule, 'down')">↓</button>
            <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="toggle(rule)">{{ rule.enabled ? 'Desligar' : 'Ligar' }}</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="startEdit(rule)">Editar</button>
            <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 hover:text-rose-300" title="Apagar" @click="removing = rule"><Icon name="trash" class="h-4 w-4" /></button>
          </div>
        </div>
      </li>
    </ol>
    <p v-if="!loading && !rules.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
      Nenhuma regra {{ scope === GLOBAL_SCOPE ? 'global' : 'do projeto' }}{{ readonly ? '' : ' ainda' }}.
    </p>

    <form v-if="!readonly" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" @submit.prevent="add">
      <p class="text-sm font-medium">Nova regra {{ scope === GLOBAL_SCOPE ? 'global' : 'do projeto' }}</p>
      <p v-if="draftNote" class="text-xs text-emerald-300">{{ draftNote }}</p>
      <label class="field">Título<input v-model="draft.title" required maxlength="120" class="input text-sm" placeholder="Idioma" /><small v-for="m in draftIssues.title" :key="m" class="error">{{ m }}</small></label>
      <label class="field">
        Regra
        <textarea v-model="draft.body" required rows="3" class="input text-sm" placeholder="Responda sempre em português do Brasil." />
        <small class="hint">Curta e direta: uma regra por vez.<template v-if="draft.body"> {{ sizeHint(draft.body, 'a cada turno') }}.</template></small>
        <small v-for="m in draftIssues.body" :key="m" class="error">{{ m }}</small>
      </label>
      <div><button type="submit" :disabled="busy" class="btn btn-primary">Adicionar</button></div>
    </form>

    <ConfirmDialog
      :open="!!removing"
      title="Apagar a regra?"
      :message="removing ? `${removing.title}. As próximas conversas não terão esta regra.` : ''"
      :busy="busy"
      @confirm="confirmRemove"
      @cancel="removing = undefined"
    />
  </section>
</template>

<style scoped>
@reference '../style.css';

.field {
  @apply flex min-w-0 flex-col gap-1.5 text-sm font-medium text-zinc-300;
}
.input {
  @apply rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-normal text-zinc-100 outline-none focus:border-emerald-500/60;
}
.hint {
  @apply text-xs font-normal text-zinc-500;
}
.error {
  @apply text-xs font-normal text-rose-300;
}
</style>
