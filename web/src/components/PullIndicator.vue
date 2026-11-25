<script setup lang="ts">
  import { computed } from 'vue'
  import { PULL_THRESHOLD, type TPullState } from '@/composables/usePullToRefresh'

  /** 🔄 O indicador do "puxar para atualizar": desce com o dedo, gira a seta no limiar e roda enquanto atualiza. */
  const props = defineProps<{ distance: number; state: TPullState }>()
  const label = computed(() => (props.state === 'refreshing' ? 'Atualizando…' : props.state === 'ready' ? 'Solte para atualizar' : 'Puxe para atualizar'))
  const progress = computed(() => Math.min(1, props.distance / PULL_THRESHOLD))
</script>

<template>
  <div
    v-if="state !== 'idle'"
    class="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center"
    :style="{ transform: `translateY(calc(env(safe-area-inset-top) + ${distance - 44}px))`, opacity: Math.max(0.3, progress) }"
    role="status"
    aria-live="polite"
    data-test="pull-indicator"
  >
    <div class="flex items-center gap-2 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-200 shadow-lg">
      <span v-if="state === 'refreshing'" class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-zinc-100" />
      <svg v-else viewBox="0 0 16 16" class="h-3.5 w-3.5 transition-transform" :class="state === 'ready' ? 'rotate-180' : ''" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 3v10M4 9l4 4 4-4" />
      </svg>
      <span>{{ label }}</span>
    </div>
  </div>
</template>
