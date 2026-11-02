<script setup lang="ts" generic="T extends string = 'edit' | 'history'">
import { computed } from 'vue'

/**
 * As guias de uma tela de edição com histórico: a edição (o rótulo é da tela), as guias a mais da tela (`extra`, como
 * "Arquivos" na skill) e "Histórico". Mesmo desenho das guias do agente. A tela abre direto no histórico com
 * `#historico` no endereço (o link da página Histórico do catálogo).
 */
const props = defineProps<{ editLabel: string; extra?: ReadonlyArray<{ id: T; label: string }> }>()
const tab = defineModel<T>({ required: true })
const items = computed(() => [{ id: 'edit' as T, label: props.editLabel }, ...(props.extra ?? []), { id: 'history' as T, label: 'Histórico' }])
</script>

<template>
  <nav class="flex gap-1 border-b border-zinc-800" role="tablist">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      role="tab"
      :aria-selected="tab === item.id"
      :data-test="`tab-${item.id}`"
      class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
      :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
      @click="tab = item.id"
    >
      {{ item.label }}
    </button>
  </nav>
</template>
