<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { IAgentResources, TResourceKind } from '@/lib/types'
import { useScopedResources } from '@/composables/useCatalogLists'
import { useResource } from '@/composables/useResource'
import { useAgentCatalogStore } from '@/stores/agentCatalog'

/**
 * Os RECURSOS do agente: as skills e os commands que ele pode usar. ⚖️ Por padrão, "Todos" = os globais e os do
 * projeto dele, inclusive os que forem criados depois. Desmarcar tudo é "nenhum". ⛔ Agente global: só os globais.
 * As listas e a escolha salva moram nas stores (as mesmas das páginas Skills e Commands).
 */
/** `embedded`: dentro do formulário do agente, sem botão próprio — quem grava é o "Salvar agente" (`commit`). */
const props = defineProps<{ agentId: string; projectId?: string; projectName?: string; embedded?: boolean }>()
const catalog = useAgentCatalogStore()

const SECTIONS: Array<{ kind: TResourceKind; field: keyof IAgentResources; title: string; hint: string; base: string }> = [
  { kind: 'skill', field: 'skills', title: 'Skills', hint: 'O agente usa quando for útil.', base: '/skills' },
  { kind: 'command', field: 'commands', title: 'Commands', hint: 'Use com /nome na conversa.', base: '/commands' },
]

const resources = useScopedResources(() => props.projectId ?? null)
const current = useResource(catalog.resources, () => props.agentId)
const available = resources.list
// ⚖️ Lido com folga: a guia fica montada desde que o agente abre, antes de a resposta chegar.
const saved = computed<IAgentResources>(() => ({ skills: current.data.value?.skills ?? [], commands: current.data.value?.commands ?? [] }))
const selected = ref<IAgentResources>({ skills: [], commands: [] })
const busy = ref(false)
const saveError = ref<unknown>()
const error = computed(() => {
  const failure = saveError.value ?? current.error.value ?? resources.error.value
  return failure === undefined ? undefined : failure instanceof Error ? failure.message : String(failure)
})
const note = ref<string>()

// A escolha salva chegou (ou mudou): a marcação volta a ela.
watch(
  () => current.data.value,
  () => (selected.value = { skills: [...saved.value.skills], commands: [...saved.value.commands] }),
  { immediate: true },
)
watch(
  () => [props.agentId, props.projectId],
  () => {
    saveError.value = undefined
    note.value = undefined
  },
)

const dirty = computed(() => SECTIONS.some(({ field }) => selected.value[field].join() !== saved.value[field].join()))
const of = (kind: TResourceKind) => available.value.filter((resource) => resource.kind === kind)
const all = (field: keyof IAgentResources) => selected.value[field].includes('*')

function toggle(field: keyof IAgentResources, id: string) {
  const list = selected.value[field]
  selected.value = { ...selected.value, [field]: list.includes(id) ? list.filter((item) => item !== id) : [...list, id] }
}

function toggleAll(field: keyof IAgentResources) {
  selected.value = { ...selected.value, [field]: all(field) ? [] : ['*'] }
}

/** O "Salvar agente" grava esta guia junto: lança se falhar, para o formulário dizer onde. */
async function commit(): Promise<void> {
  if (!dirty.value) return
  await save()
  if (saveError.value) throw saveError.value
}
defineExpose({ dirty, commit })

async function save() {
  busy.value = true
  saveError.value = undefined
  note.value = undefined
  try {
    await catalog.saveResources(props.agentId, selected.value)
    note.value = 'Salvo. Vale para as próximas conversas.'
  } catch (failure) {
    saveError.value = failure
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
    <div v-if="!embedded"><button type="button" :disabled="busy || !dirty" class="btn btn-primary" @click="save">Salvar</button></div>
    <p v-else-if="dirty" class="text-xs text-amber-300">Mudança não salva: grave com "Salvar agente".</p>
  </section>
</template>
