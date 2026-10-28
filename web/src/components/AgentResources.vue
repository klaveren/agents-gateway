<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api } from '@/lib/api'
import { GLOBAL_SCOPE } from '@/lib/guidance'
import type { IAgentResources, IResource, TResourceKind } from '@/lib/types'

/**
 * Os RECURSOS do agente: as skills e os commands que ele pode usar. ⚖️ Por padrão, "Todos" = os globais e os do
 * projeto dele, inclusive os que forem criados depois. Desmarcar tudo é "nenhum". ⛔ Agente global: só os globais.
 */
const props = defineProps<{ agentId: string; projectId?: string; projectName?: string }>()

const SECTIONS: Array<{ kind: TResourceKind; field: keyof IAgentResources; title: string; hint: string; base: string }> = [
  { kind: 'skill', field: 'skills', title: 'Skills', hint: 'O agente usa quando for útil.', base: '/skills' },
  { kind: 'command', field: 'commands', title: 'Commands', hint: 'Use com /nome na conversa.', base: '/commands' },
]

const available = ref<IResource[]>([])
const selected = ref<IAgentResources>({ skills: [], commands: [] })
const saved = ref<IAgentResources>({ skills: [], commands: [] })
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()

const dirty = computed(() => SECTIONS.some(({ field }) => selected.value[field].join() !== saved.value[field].join()))
const of = (kind: TResourceKind) => available.value.filter((resource) => resource.kind === kind)
const all = (field: keyof IAgentResources) => selected.value[field].includes('*')

watch(() => [props.agentId, props.projectId], load, { immediate: true })

async function load() {
  error.value = undefined
  note.value = undefined
  try {
    const [globals, local, current] = await Promise.all([
      api<IResource[]>('/resources', { query: { project: GLOBAL_SCOPE } }),
      props.projectId ? api<IResource[]>('/resources', { query: { project: props.projectId } }) : Promise.resolve([]),
      api<IAgentResources>(`/agents/${encodeURIComponent(props.agentId)}/resources`),
    ])
    available.value = [...local, ...globals]
    saved.value = { skills: [...current.skills], commands: [...current.commands] }
    selected.value = { skills: [...current.skills], commands: [...current.commands] }
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  }
}

function toggle(field: keyof IAgentResources, id: string) {
  const list = selected.value[field]
  selected.value = { ...selected.value, [field]: list.includes(id) ? list.filter((item) => item !== id) : [...list, id] }
}

function toggleAll(field: keyof IAgentResources) {
  selected.value = { ...selected.value, [field]: all(field) ? [] : ['*'] }
}

async function save() {
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    const result = await api<IAgentResources>(`/agents/${encodeURIComponent(props.agentId)}/resources`, { method: 'PUT', body: selected.value })
    saved.value = { skills: [...result.skills], commands: [...result.commands] }
    selected.value = { skills: [...result.skills], commands: [...result.commands] }
    note.value = 'Salvo. Vale para as próximas conversas.'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="flex flex-col gap-4">
    <p class="text-sm text-zinc-400">
      O que este agente pode usar. Desmarque "Todos" para escolher.
      <template v-if="projectId"> Valem os globais e os do projeto {{ projectName ?? projectId }}.</template>
      <template v-else> Agente global: só recursos globais.</template>
    </p>

    <div v-for="section in SECTIONS" :key="section.kind" class="flex flex-col gap-2 rounded-xl border border-zinc-800 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-medium text-zinc-200">{{ section.title }}</h3>
        <span class="text-xs text-zinc-500">{{ section.hint }}</span>
        <label class="ml-auto flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" class="accent-emerald-500" :checked="all(section.field)" @change="toggleAll(section.field)" />
          Todos (inclusive os criados depois)
        </label>
      </div>
      <p v-if="!of(section.kind).length" class="text-xs text-zinc-500">
        Nenhum ainda. <RouterLink :to="`${section.base}/new`" class="text-emerald-400 underline underline-offset-2">Criar</RouterLink>.
      </p>
      <label v-for="resource in of(section.kind)" :key="resource.id" class="flex items-center gap-2 text-sm" :class="all(section.field) ? 'opacity-50' : ''">
        <input type="checkbox" class="accent-emerald-500" :disabled="all(section.field)" :checked="all(section.field) || selected[section.field].includes(resource.id)" @change="toggle(section.field, resource.id)" />
        <RouterLink :to="`${section.base}/${resource.id}`" class="font-mono hover:underline">{{ section.kind === 'command' ? '/' : '' }}{{ resource.id }}</RouterLink>
        <span class="min-w-0 truncate text-xs text-zinc-500">{{ resource.description }}</span>
        <span class="ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" :class="resource.projectId ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'">{{ resource.projectId ? 'projeto' : 'global' }}</span>
      </label>
    </div>

    <p v-if="error" class="text-sm text-rose-300">{{ error }}</p>
    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
    <div><button type="button" :disabled="busy || !dirty" class="rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-medium text-zinc-950 hover:bg-emerald-400 disabled:opacity-40" @click="save">Salvar</button></div>
  </section>
</template>
