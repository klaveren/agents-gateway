<script setup lang="ts">
  import { computed } from 'vue'
  import { coreAgentName } from '@/lib/builder'
  import { tokens, usd } from '@/lib/format'
  import type { IToolUsage, IUsageFigure, IUsageSummary } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useProtocolsStore } from '@/stores/protocols'
  import UsageDailyChart from './UsageDailyChart.vue'
  import UsageTiles from './UsageTiles.vue'
  import ListPager from './ListPager.vue'
  import { usePaged } from '@/composables/usePaged'

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
  const agentName = (id: string) => agents.byId.get(id)?.name ?? coreAgentName(id) ?? id
  const tools = computed(() => props.summary.byTool ?? [])
  const toolMax = computed(() => Math.max(1, ...tools.value.map((item) => item.directTokens + item.contextTokens)))
  const toolWidth = (value: number) => `${(value / toolMax.value) * 100}%`
  const toolTotal = (item: IToolUsage) => item.directTokens + item.contextTokens
  // 10 por página em cada relatório; a barra continua medida contra a lista inteira.
  const agentPage = usePaged(computed(() => props.summary.byAgent))
  const modelPage = usePaged(computed(() => props.summary.byModel))
  /** Por provedor: a soma dos modelos de cada um (o custo some só se nenhum modelo o tem). */
  const byProvider = computed(() => {
    const totals = new Map<string, { provider: string; tokens: number; costUsd?: number; costIsFloor: boolean }>()
    for (const item of props.summary.byModel) {
      const entry = totals.get(item.provider) ?? { provider: item.provider, tokens: 0, costIsFloor: false }
      entry.tokens += item.usage.totalTokens
      if (item.costUsd !== undefined) entry.costUsd = (entry.costUsd ?? 0) + item.costUsd
      entry.costIsFloor ||= !!item.costIsFloor
      totals.set(item.provider, entry)
    }
    return [...totals.values()].sort((a, b) => b.tokens - a.tokens)
  })
  const providerMax = computed(() => Math.max(1, ...byProvider.value.map((item) => item.tokens)))
  const toolPage = usePaged(tools)
  const topPage = usePaged(computed(() => props.summary.top))
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

      <div class="grid gap-4 lg:grid-cols-3">
        <section class="card">
          <h2 class="card-title">Por agente</h2>
          <ul class="flex flex-col gap-2.5">
            <li v-for="item in agentPage.items.value" :key="item.agentId">
              <div class="flex items-baseline gap-2 text-sm">
                <span class="truncate text-zinc-200">{{ agentName(item.agentId) }}</span>
                <span class="ml-auto shrink-0 text-xs text-zinc-400">
                  {{ tokens(item.usage.totalTokens) }}
                  <template v-if="showCost">· {{ cost(item) }}</template>
                </span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-zinc-800"><div class="h-1.5 rounded-full bg-emerald-500/70" :style="{ width: share(item, summary.byAgent) }" /></div>
            </li>
          </ul>
          <ListPager v-model="agentPage.page.value" :pages="agentPage.pages.value" :total="agentPage.total.value" :size="agentPage.size" />
        </section>
        <section class="card">
          <h2 class="card-title">Por modelo</h2>
          <ul class="flex flex-col gap-2.5">
            <li v-for="item in modelPage.items.value" :key="`${item.provider}:${item.model}`">
              <div class="flex items-baseline gap-2 text-sm">
                <span class="truncate font-mono text-[13px] text-zinc-200">{{ item.model }}</span>
                <span class="shrink-0 text-xs text-zinc-500">{{ protocols.providerName(item.provider) }}</span>
                <span class="ml-auto shrink-0 text-xs text-zinc-400">
                  {{ tokens(item.usage.totalTokens) }}
                  <template v-if="showCost">· {{ cost(item) }}</template>
                </span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-zinc-800"><div class="h-1.5 rounded-full bg-emerald-500/70" :style="{ width: share(item, summary.byModel) }" /></div>
            </li>
          </ul>
          <ListPager v-model="modelPage.page.value" :pages="modelPage.pages.value" :total="modelPage.total.value" :size="modelPage.size" />
        </section>
        <section class="card" data-test="by-provider">
          <h2 class="card-title">Por provedor</h2>
          <ul class="flex flex-col gap-2.5">
            <li v-for="item in byProvider" :key="item.provider">
              <div class="flex items-baseline gap-2 text-sm">
                <span class="truncate text-zinc-200">{{ protocols.providerName(item.provider) }}</span>
                <span class="ml-auto shrink-0 text-xs text-zinc-400">
                  {{ tokens(item.tokens) }}
                  <template v-if="showCost && item.costUsd !== undefined">· {{ item.costIsFloor ? '≥ ' : '' }}{{ usd(item.costUsd) }}</template>
                </span>
              </div>
              <div class="mt-1 h-1.5 rounded-full bg-zinc-800">
                <div class="h-1.5 rounded-full bg-emerald-500/70" :style="{ width: `${Math.max(2, (item.tokens / providerMax) * 100)}%` }" />
              </div>
            </li>
          </ul>
        </section>
      </div>

      <section v-if="tools.length" class="card" data-test="by-tool">
        <div class="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 class="text-sm font-medium text-zinc-300">Por ferramenta</h2>
          <span class="rounded-full border border-zinc-700 px-2 text-[11px] text-zinc-400">estimativa</span>
          <span class="flex items-center gap-1.5 text-xs text-zinc-400">
            <i class="inline-block h-2 w-2 rounded-sm bg-emerald-500/80" />
            Diretos
          </span>
          <span class="flex items-center gap-1.5 text-xs text-zinc-400">
            <i class="inline-block h-2 w-2 rounded-sm bg-sky-400/60" />
            No contexto
          </span>
        </div>
        <p class="mb-3 text-xs text-zinc-500">
          O provedor cobra por chamada ao modelo, não por ferramenta: a conta sai do tamanho gravado. Diretos são os argumentos e o resultado; no contexto é o resultado relido nos
          passos seguintes do turno.
        </p>
        <ul class="flex flex-col gap-2.5">
          <li v-for="item in toolPage.items.value" :key="item.tool" :data-tool="item.tool">
            <div class="flex items-baseline gap-2 text-sm">
              <span class="truncate font-mono text-[13px] text-zinc-200">{{ item.tool }}</span>
              <span class="shrink-0 text-xs text-zinc-500">{{ item.calls }}×</span>
              <span v-if="item.errors" class="shrink-0 text-xs text-rose-300">{{ item.errors }} erro{{ item.errors > 1 ? 's' : '' }}</span>
              <span class="ml-auto shrink-0 text-xs text-zinc-400" :title="`Diretos ${tokens(item.directTokens)} · no contexto ${tokens(item.contextTokens)}`">
                ~{{ tokens(toolTotal(item)) }}
              </span>
            </div>
            <div class="mt-1 flex h-1.5 gap-0.5 rounded-full bg-zinc-800">
              <div class="h-1.5 rounded-full bg-emerald-500/80" :style="{ width: toolWidth(item.directTokens) }" />
              <div v-if="item.contextTokens" class="h-1.5 rounded-full bg-sky-400/60" :style="{ width: toolWidth(item.contextTokens) }" />
            </div>
          </li>
        </ul>
        <ListPager v-model="toolPage.page.value" :pages="toolPage.pages.value" :total="toolPage.total.value" :size="toolPage.size" />
      </section>

      <section class="card">
        <h2 class="card-title">Conversas que mais usaram</h2>
        <ul class="divide-y divide-zinc-800">
          <li v-for="item in topPage.items.value" :key="item.id" class="flex items-center gap-3 py-2 text-sm">
            <RouterLink :to="`/c/${item.id}`" class="min-w-0 flex-1 truncate text-zinc-200 hover:text-emerald-300">{{ item.title || 'Conversa sem título' }}</RouterLink>
            <span class="shrink-0 text-xs text-zinc-500">{{ agentName(item.agentId) }}</span>
            <span class="w-24 shrink-0 text-right text-xs text-zinc-400">
              {{ tokens(item.usage.totalTokens) }}
              <template v-if="showCost">
                <br />
                {{ cost(item) }}
              </template>
            </span>
          </li>
        </ul>
        <ListPager v-model="topPage.page.value" :pages="topPage.pages.value" :total="topPage.total.value" :size="topPage.size" />
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
