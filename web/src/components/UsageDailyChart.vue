<script setup lang="ts">
import { computed, ref } from 'vue'
import { tokens, usd } from '@/lib/format'
import type { IUsageFigure } from '@/lib/types'
import { USAGE_SEGMENTS, usageSegments } from '@/lib/usageSegments'

/**
 * Tokens por dia, em barras empilhadas: a entrada embaixo — o cache lido, o cache gravado e a entrada nova, que juntos
 * são a entrada — e a saída (com o raciocínio) em cima.
 *
 * ⚖️ UM EIXO, A MESMA UNIDADE (tokens), empilhadas porque a soma é a pergunta ("quanto gastei no dia?") e a divisão é a
 * segunda. As partes da entrada são tons do MESMO azul (são entrada, com preços diferentes); a saída, laranja. A
 * identidade nunca depende só da cor — legenda, tooltip e tabela nomeiam.
 */
const props = defineProps<{ days: Array<IUsageFigure & { date: string }>; showCost?: boolean }>()

const WIDTH = 720
const HEIGHT = 200
const PAD = { top: 12, right: 8, bottom: 24, left: 44 }
const GAP = 2

const hover = ref<number>()
const showTable = ref(false)

const output = (day: IUsageFigure) => day.usage.outputTokens + day.usage.reasoningTokens
const max = computed(() => Math.max(1, ...props.days.map((day) => day.usage.inputTokens + output(day))))
/** Um teto "redondo" para o eixo: 1, 2 ou 5 × 10ⁿ acima do máximo. */
const ceiling = computed(() => {
  const magnitude = 10 ** Math.floor(Math.log10(max.value))
  return [1, 2, 5, 10].map((step) => step * magnitude).find((value) => value >= max.value) ?? max.value
})
const plotHeight = HEIGHT - PAD.top - PAD.bottom
const slot = computed(() => (WIDTH - PAD.left - PAD.right) / Math.max(1, props.days.length))
const barWidth = computed(() => Math.max(3, Math.min(28, slot.value * 0.7)))
const y = (value: number) => (value / ceiling.value) * plotHeight

/** As partes de cada dia empilhadas, com um vão de 2px entre elas; só a de cima tem o topo arredondado. */
const bars = computed(() =>
  props.days.map((day, index) => {
    const x = PAD.left + index * slot.value + (slot.value - barWidth.value) / 2
    const parts = usageSegments(day)
    const present = USAGE_SEGMENTS.filter((segment) => y(parts[segment.key]) > 0)
    let top = PAD.top + plotHeight
    const pieces = present.map((segment, position) => {
      const height = y(parts[segment.key])
      top -= height + (position > 0 ? GAP : 0)
      return { key: segment.key, color: segment.color, top, height, last: position === present.length - 1 }
    })
    return { day, x, parts, pieces }
  }),
)
const ticks = computed(() => [0, 0.5, 1].map((fraction) => ({ value: ceiling.value * fraction, y: PAD.top + plotHeight - plotHeight * fraction })))
/** Rótulo de dia só a cada N, para não amontoar em 90 dias. */
const labelEvery = computed(() => Math.ceil(props.days.length / 10))

const label = (date: string) => {
  const [, month, day] = date.split('-')
  return `${day}/${month}`
}

/** Topo arredondado só no segmento de cima (o fim do dado), base reta no eixo. */
function topRounded(x: number, top: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height)
  return `M${x},${top + height}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${top + height}Z`
}
</script>

<template>
  <div class="viz-root flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
      <span v-for="segment in USAGE_SEGMENTS" :key="segment.key" class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm" :style="{ background: segment.color }" /> {{ segment.label }}</span>
      <button type="button" class="ml-auto text-zinc-400 hover:text-zinc-100" @click="showTable = !showTable">{{ showTable ? 'Ver gráfico' : 'Ver tabela' }}</button>
    </div>

    <div v-if="!showTable" class="relative" @mouseleave="hover = undefined">
      <svg :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" class="w-full" role="img" :aria-label="`Tokens por dia, ${days.length} dias`">
        <g>
          <line v-for="tick in ticks" :key="tick.value" :x1="PAD.left" :x2="WIDTH - PAD.right" :y1="tick.y" :y2="tick.y" stroke="var(--grid)" stroke-width="1" />
          <text v-for="tick in ticks" :key="`t${tick.value}`" :x="PAD.left - 6" :y="tick.y + 3" text-anchor="end" class="fill-zinc-500 text-[10px]">{{ tokens(tick.value) }}</text>
        </g>
        <g v-for="(bar, index) in bars" :key="bar.day.date">
          <!-- Alvo de hover maior que a marca: a coluna inteira do dia. -->
          <rect :x="PAD.left + index * slot" :y="PAD.top" :width="slot" :height="plotHeight" fill="transparent" @mouseenter="hover = index" />
          <path
            v-for="piece in bar.pieces"
            :key="piece.key"
            :d="piece.last ? topRounded(bar.x, piece.top, barWidth, piece.height) : `M${bar.x},${piece.top + piece.height}V${piece.top}H${bar.x + barWidth}V${piece.top + piece.height}Z`"
            :fill="piece.color"
            pointer-events="none"
            :opacity="hover === undefined || hover === index ? 1 : 0.45"
          />
          <text v-if="index % labelEvery === 0" :x="PAD.left + index * slot + slot / 2" :y="HEIGHT - 8" text-anchor="middle" class="fill-zinc-500 text-[10px]">{{ label(bar.day.date) }}</text>
        </g>
        <line :x1="PAD.left" :x2="WIDTH - PAD.right" :y1="PAD.top + plotHeight" :y2="PAD.top + plotHeight" stroke="var(--axis)" stroke-width="1" />
      </svg>

      <div
        v-if="hover !== undefined && bars[hover]"
        class="pointer-events-none absolute top-0 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl"
        :style="{ left: `${Math.min(80, ((bars[hover].x + barWidth / 2) / WIDTH) * 100)}%` }"
      >
        <div class="font-medium text-zinc-100">{{ label(bars[hover].day.date) }}</div>
        <div v-for="segment in [...USAGE_SEGMENTS].reverse()" :key="segment.key" class="mt-0.5 flex items-center gap-1.5 text-zinc-300">
          <span class="h-2 w-2 rounded-sm" :style="{ background: segment.color }" /> {{ segment.label }} {{ tokens(bars[hover].parts[segment.key]) }}
        </div>
        <div class="mt-1 text-zinc-400">Entrada total {{ tokens(bars[hover].day.usage.inputTokens) }}</div>
        <div class="mt-1 text-zinc-400">{{ bars[hover].day.turns }} turnos<template v-if="showCost && bars[hover].day.costUsd !== undefined"> · {{ bars[hover].day.costIsFloor ? '≥ ' : '' }}{{ usd(bars[hover].day.costUsd) }}</template></div>
      </div>
    </div>

    <table v-else class="w-full text-left text-xs">
      <thead class="text-zinc-500">
        <tr>
          <th class="py-1 font-medium">Dia</th>
          <th class="font-medium">Entrada</th>
          <th class="font-medium">Cache lido</th>
          <th class="font-medium">Cache gravado</th>
          <th class="font-medium">Saída</th>
          <th class="font-medium">Turnos</th>
          <th v-if="showCost" class="font-medium">Custo</th>
        </tr>
      </thead>
      <tbody class="text-zinc-300">
        <tr v-for="day in days.filter((item) => item.turns)" :key="day.date" class="border-t border-zinc-800">
          <td class="py-1">{{ label(day.date) }}</td>
          <td>{{ tokens(day.usage.inputTokens) }}</td>
          <td>{{ tokens(day.usage.cacheReadTokens) }}</td>
          <td>{{ tokens(day.usage.cacheWriteTokens) }}</td>
          <td>{{ tokens(output(day)) }}</td>
          <td>{{ day.turns }}</td>
          <td v-if="showCost">{{ day.costIsFloor ? '≥ ' : '' }}{{ usd(day.costUsd) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
/* A interface é escura: os passos escuros da paleta de referência (validados contra o fundo). */
.viz-root {
  --series-1: #3987e5;
  --series-2: #d95926;
  /* As parcelas de cache: o mesmo azul da entrada, mais escuro (lido, o mais barato) e mais claro (gravado). */
  --series-cache-read: #1d4f8c;
  --series-cache-write: #8db8f2;
  --grid: rgb(63 63 70 / 0.45);
  --axis: rgb(82 82 91);
}
</style>
