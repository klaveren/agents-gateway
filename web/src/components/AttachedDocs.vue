<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TAttachMode } from '@/lib/guidance'

/**
 * OS DOCUMENTOS ANEXADOS de um doc, de uma skill ou de um command: em cima os escolhidos (como vão junto, e o peso
 * somado), embaixo todos os que dá para anexar, com busca. Só a tela: quem embute guarda `docIds`/`docRefs`.
 */
interface IAttachable {
  id: string
  kind: string
  title: string
  tokens?: number
}

const props = defineProps<{
  attachable: readonly IAttachable[]
  selected: readonly string[]
  modeOf: (id: string) => TAttachMode
  /** Para quem não há o que anexar (o escopo), na frase do vazio. */
  emptyText: string
}>()
const emit = defineEmits<{ toggle: [id: string]; mode: [id: string, mode: TAttachMode] }>()

const query = ref('')
const byId = computed(() => new Map(props.attachable.map((doc) => [doc.id, doc])))
const chosen = computed(() => props.selected.flatMap((id) => (byId.value.get(id) ? [byId.value.get(id)!] : [])))
/** O peso do que vai junto: o inteiro conta tudo; o por referência, quase nada (id, título e tamanho). */
const weight = computed(() => chosen.value.reduce((sum, doc) => sum + (props.modeOf(doc.id) === 'inline' ? (doc.tokens ?? 0) : 0), 0))
const rest = computed(() => {
  const text = query.value.trim().toLowerCase()
  return props.attachable.filter((doc) => !props.selected.includes(doc.id) && (!text || `${doc.title} ${doc.id} ${doc.kind}`.toLowerCase().includes(text)))
})
const tokens = (value?: number) => `≈ ${(value ?? 0).toLocaleString('pt-BR')} tokens`
</script>

<template>
  <div class="flex flex-col gap-4" data-test="attached-docs">
    <section class="flex flex-col gap-1.5 rounded-xl border border-emerald-500/30 p-3">
      <p class="flex flex-wrap items-baseline gap-2 text-sm font-medium text-zinc-200">
        Anexados ({{ chosen.length }})
        <span class="text-xs font-normal text-zinc-500">— vão junto quando este é lido · {{ tokens(weight) }} inteiros</span>
      </p>
      <p v-if="!chosen.length" class="text-xs text-zinc-500">Nenhum. Escolha abaixo.</p>
      <div v-for="doc in chosen" :key="doc.id" class="flex flex-wrap items-center gap-2 text-sm" data-test="attached-doc">
        <span class="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 uppercase">{{ doc.kind }}</span>
        <span class="min-w-0 flex-1 truncate">{{ doc.title }}</span>
        <span class="shrink-0 text-xs text-zinc-500 tabular-nums">{{ tokens(doc.tokens) }}</span>
        <select
          :value="modeOf(doc.id)"
          class="input w-auto py-1 text-xs"
          :aria-label="`Como ${doc.title} vai junto`"
          data-test="attached-mode"
          @change="emit('mode', doc.id, ($event.target as HTMLSelectElement).value as TAttachMode)"
        >
          <option value="inline">inteiro</option>
          <option value="reference">por referência</option>
        </select>
        <button type="button" class="btn btn-ghost btn-sm" :aria-label="`Tirar ${doc.title}`" data-test="attached-remove" @click="emit('toggle', doc.id)">Tirar</button>
      </div>
    </section>

    <section class="flex flex-col gap-1.5 rounded-xl border border-zinc-800 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-sm font-medium text-zinc-200">Todos ({{ attachable.length - chosen.length }})</p>
        <input v-model="query" type="search" class="input ml-auto w-full max-w-64 py-1 text-sm" placeholder="Buscar por título ou id" aria-label="Buscar documento" data-test="attached-search" />
      </div>
      <p v-if="!attachable.length" class="text-xs text-zinc-500">{{ emptyText }}</p>
      <p v-else-if="!rest.length" class="text-xs text-zinc-500">Nada {{ query ? 'com essa busca' : 'mais a anexar' }}.</p>
      <label v-for="doc in rest" :key="doc.id" class="flex min-w-0 items-center gap-2 text-sm" data-test="attachable-doc">
        <input type="checkbox" class="accent-emerald-500" :checked="false" @change="emit('toggle', doc.id)" />
        <span class="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400 uppercase">{{ doc.kind }}</span>
        <span class="min-w-0 truncate">{{ doc.title }}</span>
        <span class="ml-auto shrink-0 text-xs text-zinc-500 tabular-nums">{{ tokens(doc.tokens) }}</span>
      </label>
    </section>
  </div>
</template>
