<script setup lang="ts">
/** O selo da lista: quantos problemas da importação o artefato tem (o detalhe mostra quais). */
defineProps<{ count?: number }>()
</script>

<template>
  <span
    v-if="count"
    class="inline-block shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
    :title="`${count} problema(s) da importação`"
    data-test="import-issues-badge"
    >{{ count }} problema{{ count > 1 ? 's' : '' }} da importação</span
  >
</template>
