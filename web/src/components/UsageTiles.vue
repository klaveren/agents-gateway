<script setup lang="ts">
import { tokens, usd } from '@/lib/format'
import type { IUsageFigure } from '@/lib/types'

/**
 * Os cartões de um bloco de uso — tokens, conversas, turnos, custo (só com `showCost`), entrada, saída e
 * cache —, iguais em "Meu uso", "Por usuário" e "Por chave". O slot acrescenta cartões da visão (ex.: quantos usuários).
 */
defineProps<{ figure: IUsageFigure; showCost: boolean }>()

const cost = (item: IUsageFigure) => (item.costUsd === undefined ? '—' : `${item.costIsFloor ? '≥ ' : ''}${usd(item.costUsd)}`)
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex flex-wrap gap-2">
      <div v-if="showCost" class="tile wide"><span class="tile-label">Custo estimado</span><span class="tile-value">{{ cost(figure) }}</span></div>
      <div class="tile"><span class="tile-label">Tokens</span><span class="tile-value">{{ tokens(figure.usage.totalTokens) }}</span></div>
      <slot />
      <div class="tile"><span class="tile-label">Conversas</span><span class="tile-value">{{ figure.conversations }}</span></div>
      <div class="tile"><span class="tile-label">Turnos</span><span class="tile-value">{{ figure.turns }}</span></div>
      <div class="tile"><span class="tile-label">Entrada</span><span class="tile-value">{{ tokens(figure.usage.inputTokens) }}</span></div>
      <div class="tile"><span class="tile-label">Saída</span><span class="tile-value">{{ tokens(figure.usage.outputTokens) }}</span></div>
      <div class="tile"><span class="tile-label">Cache lido</span><span class="tile-value">{{ tokens(figure.usage.cacheReadTokens) }}</span></div>
      <div class="tile"><span class="tile-label">Cache gravado</span><span class="tile-value">{{ tokens(figure.usage.cacheWriteTokens) }}</span></div>
    </div>
    <p class="text-xs text-zinc-500">
      Raciocínio {{ tokens(figure.usage.reasoningTokens) }} (cobrado como saída)
      <template v-if="showCost && figure.costIsFloor"> · ≥ = há modelo sem preço; o custo é um piso</template>
    </p>
  </div>
</template>

<style scoped>
@reference '../style.css';

.tile,
:slotted(.tile) {
  @apply flex min-w-fit flex-1 basis-20 flex-col gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-2.5;
}
.tile.wide {
  @apply min-w-28 basis-28 grow-[1.6];
}
.tile-label,
:slotted(.tile-label) {
  @apply whitespace-nowrap text-[11px] text-zinc-500;
}
.tile-value,
:slotted(.tile-value) {
  @apply truncate text-lg font-semibold text-zinc-100 tabular-nums;
}
</style>
