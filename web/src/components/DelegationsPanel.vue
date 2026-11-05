<script setup lang="ts">
  import { computed, ref } from 'vue'
  import { tokens, usd } from '@/lib/format'
  import type { IConversation } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useConversationsStore } from '@/stores/conversations'

  /**
   * As conversas que esta abriu por delegação, no padrão das Tarefas: recolhida, a contagem (quantas já acabaram) e quem
   * ainda trabalha; aberta, uma por agente, com o link para a conversa filha.
   */
  const props = defineProps<{ items: IConversation[]; showCost: boolean }>()
  const agents = useAgentsStore()
  const conversations = useConversationsStore()
  const open = ref(false)

  const isRunning = (child: IConversation) => conversations.running.has(child.id)
  const working = computed(() => props.items.filter(isRunning))
  const done = computed(() => props.items.length - working.value.length)
  const total = computed(() => props.items.reduce((sum, child) => sum + (child.usage.totalTokens ?? 0), 0))
  const cost = computed(() => (props.items.some((child) => child.costUsd !== undefined) ? props.items.reduce((sum, child) => sum + (child.costUsd ?? 0), 0) : undefined))
  const nameOf = (child: IConversation) => agents.byId.get(child.agentId)?.name ?? child.agentId
</script>

<template>
  <div class="border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2 text-sm" data-test="delegations">
    <button type="button" class="flex w-full items-center gap-2 text-left" :aria-expanded="open" data-test="delegations-toggle" @click="open = !open">
      <span class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Delegações</span>
      <span class="shrink-0 text-xs text-zinc-500">
        {{ done }} de {{ items.length }}{{ working.length ? '' : ' · concluídas' }} · {{ tokens(total) }} tokens
        <template v-if="showCost && cost !== undefined">· {{ usd(cost) }}</template>
      </span>
      <span v-if="!open && working.length" class="min-w-0 flex-1 truncate text-xs text-sky-300">{{ working.map(nameOf).join(', ') }} trabalhando</span>
      <span class="ml-auto text-xs text-zinc-500">{{ open ? '▾' : '▴' }}</span>
    </button>
    <ol v-if="open" class="mt-1.5 flex max-h-44 flex-col gap-1 overflow-y-auto">
      <li v-for="child in items" :key="child.id">
        <RouterLink :to="`/c/${child.id}`" class="flex items-center gap-2 rounded-md py-0.5 hover:bg-zinc-800/60" :data-child="child.id">
          <span
            class="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border text-[9px] leading-none"
            :class="isRunning(child) ? 'animate-pulse border-sky-400 bg-sky-400/20' : 'border-emerald-500 bg-emerald-500 text-zinc-950'"
            aria-hidden="true"
          >
            {{ isRunning(child) ? '' : '✓' }}
          </span>
          <span class="shrink-0 text-[13px] font-medium" :class="isRunning(child) ? 'text-sky-200' : 'text-zinc-200'">{{ nameOf(child) }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-zinc-500">{{ child.title }}</span>
          <span class="shrink-0 text-xs text-zinc-500">{{ tokens(child.usage.totalTokens ?? 0) }}</span>
        </RouterLink>
      </li>
    </ol>
  </div>
</template>
