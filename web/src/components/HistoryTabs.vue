<script setup lang="ts">
/**
 * As guias de uma tela de edição com histórico: a edição (o rótulo é da tela) e "Histórico". Mesmo desenho das guias
 * do agente. A tela abre direto no histórico com `#historico` no endereço (o link da página Histórico do catálogo).
 */
defineProps<{ editLabel: string }>()
const tab = defineModel<'edit' | 'history'>({ required: true })
</script>

<template>
  <nav class="flex gap-1 border-b border-zinc-800" role="tablist">
    <button
      v-for="item in [
        { id: 'edit' as const, label: editLabel },
        { id: 'history' as const, label: 'Histórico' },
      ]"
      :key="item.id"
      type="button"
      role="tab"
      :aria-selected="tab === item.id"
      class="shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap"
      :class="tab === item.id ? 'border-emerald-500 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-200'"
      @click="tab = item.id"
    >
      {{ item.label }}
    </button>
  </nav>
</template>
