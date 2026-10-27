<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import Icon from '@/components/Icon.vue'
import { api, ApiError } from '@/lib/api'
import { GLOBAL_SCOPE, scopeLabel, scopeToProjectId } from '@/lib/guidance'
import type { IRule } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'

/**
 * As RULES (só admin): as regras do ambiente que todo agente respeita, uma por registro ("Rule 1", "Rule 2"…).
 * ⚖️ Globais valem em todos os projetos; as de um projeto, só nele. A conversa nova recebe as ligadas no
 * system prompt — as globais e depois as do projeto dela.
 */
const auth = useAuthStore()
const projects = useProjectsStore()

const scope = ref<string>(projects.current ?? GLOBAL_SCOPE)
const rules = ref<IRule[]>([])
const globalCount = ref(0)
const loading = ref(false)
const error = ref<string>()
const draft = ref({ title: '', body: '' })
const draftIssues = ref<Record<string, string[]>>({})
const editing = ref<string>()
const edit = ref({ title: '', body: '' })
const removing = ref<IRule>()
const busy = ref(false)

const scopes = computed(() => [{ id: GLOBAL_SCOPE, name: 'Global — todos os projetos' }, ...projects.list.map((project) => ({ id: project.id, name: project.name }))])
const label = computed(() => scopeLabel(scope.value, projects.list))

onMounted(async () => {
  if (!auth.isAdmin) return
  if (!projects.loaded) await projects.load().catch(() => undefined)
  await load()
})
watch(scope, () => {
  editing.value = undefined
  void load()
})

async function load() {
  loading.value = true
  error.value = undefined
  try {
    rules.value = await api<IRule[]>('/rules', { query: { project: scope.value } })
    globalCount.value = scope.value === GLOBAL_SCOPE ? 0 : (await api<IRule[]>('/rules', { query: { project: GLOBAL_SCOPE } })).filter((rule) => rule.enabled).length
  } catch (failure) {
    error.value = describe(failure)
  } finally {
    loading.value = false
  }
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
    await api('/rules', { method: 'POST', body: { ...draft.value, projectId: scopeToProjectId(scope.value) } })
    draft.value = { title: '', body: '' }
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
  <div v-if="!auth.isAdmin" class="grid h-full place-items-center p-6 text-center text-zinc-400">
    <p class="font-medium text-zinc-200">Só quem administra cadastra as rules.</p>
  </div>

  <div v-else class="scroll-thin h-full overflow-y-auto px-4 py-5">
    <section class="mx-auto flex max-w-3xl flex-col gap-4">
      <header class="flex flex-wrap items-center gap-3">
        <h1 class="text-xl font-semibold">Rules</h1>
        <select v-model="scope" class="input ml-auto w-auto py-1.5 text-sm" aria-label="Escopo">
          <option v-for="item in scopes" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </header>
      <p class="text-xs text-zinc-500">
        As regras do ambiente que todo agente respeita. Entram no system prompt de cada conversa nova: as globais e depois as do projeto dela. Editar vale para as próximas conversas.
        <template v-if="scope !== GLOBAL_SCOPE && globalCount"> Aqui, além destas, os agentes recebem as {{ globalCount }} globais ligadas.</template>
      </p>

      <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
      <p v-if="!loading && !rules.length" class="rounded-xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">Nenhuma rule em {{ label }} ainda.</p>

      <ol class="flex flex-col gap-2">
        <li v-for="(rule, index) in rules" :key="rule.id" class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3" :class="rule.enabled ? '' : 'opacity-60'">
          <form v-if="editing === rule.id" class="flex flex-col gap-2" @submit.prevent="saveEdit(rule)">
            <input v-model="edit.title" required maxlength="120" class="input text-sm font-medium" aria-label="Título" />
            <textarea v-model="edit.body" required rows="3" maxlength="4000" class="input text-sm" aria-label="Regra" />
            <div class="flex gap-2">
              <button type="submit" :disabled="busy" class="rounded-full bg-emerald-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">Salvar</button>
              <button type="button" class="rounded-full px-3 py-1.5 text-sm hover:bg-zinc-800" @click="editing = undefined">Cancelar</button>
            </div>
          </form>
          <div v-else class="flex items-start gap-3">
            <span class="mt-0.5 shrink-0 rounded-md bg-zinc-800 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">Rule {{ rule.position }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium">{{ rule.title }}<span v-if="!rule.enabled" class="ml-2 text-xs font-normal text-zinc-500">desligada</span></p>
              <p class="mt-0.5 text-sm whitespace-pre-line text-zinc-400">{{ rule.body }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-0.5 text-zinc-400">
              <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="busy || index === 0" title="Subir" @click="move(rule, 'up')">↑</button>
              <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 disabled:opacity-30" :disabled="busy || index === rules.length - 1" title="Descer" @click="move(rule, 'down')">↓</button>
              <button type="button" class="rounded-full px-2 py-1 text-xs hover:bg-zinc-800" :disabled="busy" @click="toggle(rule)">{{ rule.enabled ? 'Desligar' : 'Ligar' }}</button>
              <button type="button" class="rounded-full px-2 py-1 text-xs hover:bg-zinc-800" @click="startEdit(rule)">Editar</button>
              <button type="button" class="grid h-7 w-7 place-items-center rounded-full hover:bg-zinc-800 hover:text-rose-300" title="Apagar" @click="removing = rule"><Icon name="trash" class="h-4 w-4" /></button>
            </div>
          </div>
        </li>
      </ol>

      <form class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3" @submit.prevent="add">
        <p class="text-sm font-medium">Nova rule em {{ label }}</p>
        <label class="field">Título<input v-model="draft.title" required maxlength="120" class="input text-sm" placeholder="Idioma" /><small v-for="m in draftIssues.title" :key="m" class="error">{{ m }}</small></label>
        <label class="field">
          Regra
          <textarea v-model="draft.body" required rows="3" maxlength="4000" class="input text-sm" placeholder="Responda sempre em português do Brasil." />
          <small class="hint">Curta e no imperativo: uma regra por registro.</small>
          <small v-for="m in draftIssues.body" :key="m" class="error">{{ m }}</small>
        </label>
        <div><button type="submit" :disabled="busy" class="rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">Adicionar</button></div>
      </form>
    </section>

    <ConfirmDialog
      :open="!!removing"
      title="Apagar a rule?"
      :message="removing ? `Rule ${removing.position} — ${removing.title}. As conversas novas deixam de recebê-la; as seguintes são renumeradas.` : ''"
      :busy="busy"
      @confirm="confirmRemove"
      @cancel="removing = undefined"
    />
  </div>
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
