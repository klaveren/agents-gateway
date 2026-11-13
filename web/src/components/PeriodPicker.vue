<script setup lang="ts">
  /** O período das páginas de Logs (API, Erros): os mesmos botões, no mesmo lugar, em todas. */
  const PERIODS = [
    { days: 1, label: '24 h' },
    { days: 7, label: '7 dias' },
    { days: 30, label: '30 dias' },
    { days: 90, label: '90 dias' },
  ]
  const days = defineModel<number>({ required: true })
</script>

<template>
  <div class="ml-auto flex shrink-0 gap-1 rounded-full bg-zinc-900 p-1 text-sm whitespace-nowrap" role="group" aria-label="Período">
    <button
      v-for="period in PERIODS"
      :key="period.days"
      type="button"
      class="rounded-full px-3 py-1"
      :class="days === period.days ? 'bg-zinc-700 text-white' : 'text-zinc-400'"
      :aria-pressed="days === period.days"
      @click="days = period.days"
    >
      {{ period.label }}
    </button>
  </div>
</template>
