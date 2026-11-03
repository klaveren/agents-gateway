<script setup lang="ts">
/** O selo da lista de agentes: quantos pedidos de permissão esperam confirmação (a guia Permissões mostra quais). */
defineProps<{ count?: number }>()
</script>

<template>
  <span
    v-if="count"
    class="inline-block shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
    :title="`${count} pedido(s) de permissão esperando confirmação (guia Permissões)`"
    data-test="permission-requests-badge"
    >{{ count }} pedido{{ count > 1 ? 's' : '' }}</span
  >
</template>
