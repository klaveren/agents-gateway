<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProjectsStore } from '@/stores/projects'
import SaveFooter from './SaveFooter.vue'

/**
 * A guia COMPARTILHAR (skill, command, spec e conhecimento): os projetos que também recebem o item, só para leitura.
 * ⛔ Só aparecem os projetos que a pessoa administra (o servidor confere de novo), menos o dono do item. O Salvar manda a
 * lista INTEIRA (`save`); desmarcar tudo é parar de compartilhar. Segredos não vão junto: cada projeto configura os seus.
 */
const props = defineProps<{
  /** O projeto dono do item (fora da lista). */
  owner: string
  /** Os projetos com que o item está compartilhado (o salvo). */
  shared: readonly string[]
  /** Grava a lista inteira. */
  save: (projects: string[]) => Promise<unknown>
  /** O texto de cima (o padrão é o dos recursos e documentos). */
  description?: string
}>()
const projects = useProjectsStore()

/** Os projetos que a pessoa administra, menos o do item. */
const options = computed(() => projects.list.filter((project) => project.role === 'admin' && project.id !== props.owner))
const selected = ref<string[]>([])
const busy = ref(false)
const error = ref<string>()
const note = ref<string>()

watch(
  () => props.shared,
  (list) => (selected.value = [...list]),
  { immediate: true },
)

const dirty = computed(() => [...selected.value].sort().join() !== [...props.shared].sort().join())

function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((item) => item !== id) : [...selected.value, id]
}

async function submit() {
  busy.value = true
  error.value = undefined
  note.value = undefined
  try {
    await props.save([...selected.value])
    note.value = 'Salvo.'
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3" data-test="share-projects">
    <p class="text-sm text-zinc-400">{{ description ?? 'O outro projeto usa só para leitura; a manutenção continua aqui. Segredos não vão junto: cada projeto configura os seus.' }}</p>
    <p v-if="!options.length" class="rounded-xl border border-dashed border-zinc-800 p-3 text-center text-sm text-zinc-500" data-test="share-empty">Você não administra outro projeto para compartilhar.</p>
    <ul v-else class="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
      <li v-for="project in options" :key="project.id">
        <label class="flex items-center gap-3 px-3 py-2 text-sm">
          <input type="checkbox" class="accent-emerald-500" :checked="selected.includes(project.id)" :data-project="project.id" @change="toggle(project.id)" />
          <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
          <span class="shrink-0 font-mono text-xs text-zinc-500">{{ project.id }}</span>
        </label>
      </li>
    </ul>
    <p v-if="error" class="text-sm text-rose-300" data-test="share-error">{{ error }}</p>
    <p v-if="note" class="text-sm text-emerald-300">{{ note }}</p>
    <SaveFooter label="Salvar compartilhamento" :busy="busy" :disabled="!dirty" :pending="dirty" @save="submit" />
  </div>
</template>
