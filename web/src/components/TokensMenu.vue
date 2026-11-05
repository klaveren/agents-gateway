<script setup lang="ts">
  import { computed } from 'vue'
  import { tokens, usd } from '@/lib/format'
  import { usePopover } from '@/lib/popover'
  import type { IUsage } from '@/lib/types'
  import Icon from './Icon.vue'

  /**
   * O consumo da conversa no cabeçalho: um ícone que abre o detalhe, no estilo do menu da conta. O total soma a releitura
   * do cache, então o que a conversa gerou de fato (entrada nova e saída) vem separado. Custo só para quem administra.
   */
  const props = defineProps<{ usage: IUsage; costUsd?: number; costIsFloor?: boolean; turns?: number; context?: { label: string; percent?: number } }>()
  const { open, root } = usePopover()

  const exact = (value: number | undefined) => (value ?? 0).toLocaleString('pt-BR')
  const rows = computed(() =>
    [
      { label: 'Entrada nova', value: props.usage.inputTokens },
      { label: 'Saída', value: props.usage.outputTokens },
      { label: 'Raciocínio', value: props.usage.reasoningTokens },
      { label: 'Cache lido', value: props.usage.cacheReadTokens },
      { label: 'Cache gravado', value: props.usage.cacheWriteTokens },
    ].filter((row) => row.value),
  )
  const title = computed(() => `${tokens(props.usage.totalTokens)} tokens${props.costUsd !== undefined ? ` · ${props.costIsFloor ? '≥ ' : ''}${usd(props.costUsd)}` : ''}`)
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800"
      :class="open ? 'text-emerald-400' : 'text-zinc-400'"
      :title="title"
      :aria-expanded="open"
      aria-haspopup="menu"
      data-test="tokens-menu"
      @click="open = !open"
    >
      <Icon name="tokens" class="h-5 w-5" />
    </button>
    <div v-if="open" role="menu" class="absolute top-full right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40">
      <div class="border-b border-zinc-800 px-3 py-2.5">
        <div class="text-xs text-zinc-500">Consumo da conversa</div>
        <div class="flex items-baseline gap-2">
          <span class="text-lg font-semibold text-zinc-100 tabular-nums">{{ tokens(usage.totalTokens) }}</span>
          <span class="text-xs text-zinc-500">tokens</span>
          <span v-if="costUsd !== undefined" class="ml-auto font-medium text-zinc-200 tabular-nums" :title="costIsFloor ? 'Pelo menos: algum modelo sem preço cadastrado' : undefined">
            {{ costIsFloor ? '≥ ' : '' }}{{ usd(costUsd) }}
          </span>
        </div>
      </div>
      <dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs">
        <template v-for="row in rows" :key="row.label">
          <dt class="text-zinc-400">{{ row.label }}</dt>
          <dd class="text-right text-zinc-200 tabular-nums">{{ exact(row.value) }}</dd>
        </template>
        <dt class="border-t border-zinc-800 pt-1.5 text-zinc-400">Total</dt>
        <dd class="border-t border-zinc-800 pt-1.5 text-right font-medium text-zinc-100 tabular-nums">{{ exact(usage.totalTokens) }}</dd>
      </dl>
      <div v-if="context || turns" class="flex flex-col gap-1 border-t border-zinc-800 px-3 py-2.5 text-xs text-zinc-400">
        <div v-if="context" class="flex justify-between gap-3">
          <span>Contexto agora</span>
          <span class="text-zinc-200 tabular-nums">{{ context.label }}<template v-if="context.percent !== undefined"> · {{ context.percent }}%</template></span>
        </div>
        <div v-if="turns" class="flex justify-between gap-3">
          <span>Turnos</span>
          <span class="text-zinc-200 tabular-nums">{{ turns }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
