<script setup lang="ts">
import { computed } from 'vue'
import { tokens, usd } from '@/lib/format'
import type { IUsageFigure, IUsageSummary } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useProtocolsStore } from '@/stores/protocols'
import UsageDailyChart from './UsageDailyChart.vue'
import UsageTiles from './UsageTiles.vue'

/** O resumo de uso — o meu, ou o de um usuário (admin, com custo). */
const props = defineProps<{ summary: IUsageSummary; showCost: boolean }>()

const agents = useAgentsStore()
const protocols = useProtocolsStore()

const t = computed(() => props.summary.totals)
const cost = (item: IUsageFigure) => (item.costUsd === undefined ? '' : `${item.costIsFloor ? '≥ ' : ''}${usd(item.costUsd)}`)
const share = (item: IUsageFigure, list: IUsageFigure[]) => {
  const max = Math.max(1, ...list.map((other) => other.usage.totalTokens))
  return `${Math.max(2, (item.usage.totalTokens / max) * 100)}%`
}
const agentName = (id: string) => agents.byId.get(id)?.name ?? id
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!t.turns" class="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 text-center text-sm text-zinc-400">Nenhum uso neste período.</p>

    <template v-else>
      <UsageTiles :figure="t" :show-cost="showCost" />

      <section class="card">
        <h2 class="card-title">Por dia</h2>
        <UsageDailyChart :days="summary.daily" :show-cost="showCost" />
      </section>

      <div class="grid gap-4 lg:grid-cols-2">
        <section class="card">
          <h2 class="card-title">Por agente</h2>
          <ul class="flex flex-col gap-2.5">
            <li v-for="item in summary.byAgent" :key="item.agentId">
              <div class="flex items-baseline gap-2 text-sm">
                <span class="truncate text-zinc-200">{{ agentName(item.agentId) }}</span>
                <span class="ml-auto shrink-0 text-xs text-zinc-400">{{ tokens(item.usage.totalTokens) }}<template v-if="showCost"> · {{ cost(item) }}</template></span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-zinc-800"><div class="h-1.5 rounded-full bg-emerald-500/70" :style="{ width: share(item, summary.byAgent) }" /></div>
            </li>
          </ul>
        </section>
        <section class="card">
          <h2 class="card-title">Por modelo</h2>
          <ul class="flex flex-col gap-2.5">
            <li v-for="item in summary.byModel" :key="`${item.provider}:${item.model}`">
              <div class="flex items-baseline gap-2 text-sm">
                <span class="truncate font-mono text-[13px] text-zinc-200">{{ item.model }}</span>
                <span class="shrink-0 text-xs text-zinc-500">{{ protocols.providerName(item.provider) }}</span>
                <span class="ml-auto shrink-0 text-xs text-zinc-400">{{ tokens(item.usage.totalTokens) }}<template v-if="showCost"> · {{ cost(item) }}</template></span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-zinc-800"><div class="h-1.5 rounded-full bg-emerald-500/70" :style="{ width: share(item, summary.byModel) }" /></div>
            </li>
          </ul>
        </section>
      </div>

      <section class="card">
        <h2 class="card-title">Conversas que mais consumiram</h2>
        <ul class="divide-y divide-zinc-800">
          <li v-for="item in summary.top" :key="item.id" class="flex items-center gap-3 py-2 text-sm">
            <RouterLink :to="`/c/${item.id}`" class="min-w-0 flex-1 truncate text-zinc-200 hover:text-emerald-300">{{ item.title || 'Conversa sem título' }}</RouterLink>
            <span class="shrink-0 text-xs text-zinc-500">{{ agentName(item.agentId) }}</span>
            <span class="w-24 shrink-0 text-right text-xs text-zinc-400">{{ tokens(item.usage.totalTokens) }}<template v-if="showCost"><br />{{ cost(item) }}</template></span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
@reference '../style.css';

.card {
  @apply rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4;
}
.card-title {
  @apply mb-3 text-sm font-medium text-zinc-300;
}
</style>
