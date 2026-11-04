<script setup lang="ts">
  import Icon from './Icon.vue'

  /** O ícone do Painel da conversa no cabeçalho, com o selo dos itens em aberto (some quando não há). */
  defineProps<{ count?: number; active?: boolean }>()
</script>

<template>
  <button
    type="button"
    class="relative grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800"
    :class="active ? 'text-emerald-400' : 'text-zinc-400'"
    title="Painel da conversa"
    data-test="panel-toggle"
  >
    <Icon name="panel" class="h-5 w-5" />
    <span
      v-if="count && count > 0"
      data-test="panel-badge"
      class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-emerald-500/20 px-1 text-center text-[10px] leading-4 text-emerald-300"
    >
      {{ count }}
    </span>
  </button>
</template>
