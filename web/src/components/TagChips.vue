<script setup lang="ts">
  import { computed } from 'vue'

  /** As tags de um item numa linha de lista: pequenas, apagadas, até `max` e "+N" para o resto. */
  const props = withDefaults(defineProps<{ tags?: readonly string[]; max?: number }>(), { max: 3 })
  const shown = computed(() => (props.tags ?? []).slice(0, props.max))
  const more = computed(() => Math.max(0, (props.tags?.length ?? 0) - props.max))
</script>

<template>
  <span v-if="shown.length" class="mt-1 flex max-w-full items-center gap-1 overflow-hidden" :title="tags?.join(', ')">
    <span v-for="tag in shown" :key="tag" class="max-w-24 truncate rounded-full bg-zinc-800/70 px-1.5 py-px text-[10px] text-zinc-400">{{ tag }}</span>
    <span v-if="more" class="shrink-0 text-[10px] text-zinc-500">+{{ more }}</span>
  </span>
</template>
