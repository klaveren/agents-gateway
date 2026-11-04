<script setup lang="ts">
import { computed, ref } from 'vue'
import DocStatusBadge from '@/components/DocStatusBadge.vue'
import type { TDocStatus } from '@/lib/types'

/**
 * OS DOCUMENTOS QUE ESTE SUBSTITUI: em cima os escolhidos, embaixo os que dá para escolher (do mesmo tipo e do escopo),
 * com busca. Só a tela: quem guarda é o formulário (`supersedes`).
 */
interface IPickable {
  id: string
  title: string
  status?: TDocStatus
}

const props = defineProps<{ options: readonly IPickable[]; selected: readonly string[]; emptyText: string }>()
const emit = defineEmits<{ toggle: [id: string] }>()

const query = ref('')
const byId = computed(() => new Map(props.options.map((doc) => [doc.id, doc])))
// Um id que não está nas opções (outro escopo) continua na lista, pelo id, para dar para tirar.
const chosen = computed(() => props.selected.map((id) => byId.value.get(id) ?? { id, title: id }))
const rest = computed(() => {
  const text = query.value.trim().toLowerCase()
  return props.options.filter((doc) => !props.selected.includes(doc.id) && (!text || `${doc.title} ${doc.id}`.toLowerCase().includes(text)))
})
</script>

<template>
  <div class="flex flex-col gap-2" data-test="supersedes-picker">
    <p v-if="!chosen.length" class="text-xs text-zinc-500">Nenhuma. Escolha abaixo.</p>
    <div v-for="doc in chosen" :key="doc.id" class="flex items-center gap-2 text-sm" data-test="supersedes-chosen">
      <span class="min-w-0 flex-1 truncate">{{ doc.title }} <span class="font-mono text-xs text-zinc-500">{{ doc.id }}</span></span>
      <button type="button" class="btn btn-ghost btn-sm" :aria-label="`Tirar ${doc.title}`" @click="emit('toggle', doc.id)">Tirar</button>
    </div>
    <details v-if="options.length" class="rounded-lg border border-zinc-800 p-2">
      <summary class="cursor-pointer text-xs text-zinc-400">Escolher ({{ rest.length }})</summary>
      <div class="mt-2 flex flex-col gap-1.5">
        <input v-model="query" type="search" class="input py-1 text-sm" placeholder="Buscar por título ou id" aria-label="Buscar documento a substituir" />
        <p v-if="!rest.length" class="text-xs text-zinc-500">Nada {{ query ? 'com essa busca' : 'mais a escolher' }}.</p>
        <label v-for="doc in rest" :key="doc.id" class="flex min-w-0 items-center gap-2 text-sm" data-test="supersedes-option">
          <input type="checkbox" class="accent-emerald-500" :checked="false" @change="emit('toggle', doc.id)" />
          <span class="min-w-0 truncate">{{ doc.title }}</span>
          <DocStatusBadge :status="doc.status" />
        </label>
      </div>
    </details>
    <p v-else class="text-xs text-zinc-500">{{ emptyText }}</p>
  </div>
</template>
