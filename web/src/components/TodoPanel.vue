<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ITodoItem } from '@/lib/types'

/**
 * A lista de tarefas que o agente mantém na conversa (`update_todos`), logo acima da caixa de mensagem. Recolhida, mostra
 * a contagem e o que está em andamento; aberta, a lista inteira.
 */
const props = defineProps<{ items: ITodoItem[] }>()
const open = ref(true)

const done = computed(() => props.items.filter((item) => item.status === 'done').length)
const current = computed(() => props.items.find((item) => item.status === 'in_progress'))
const finished = computed(() => props.items.every((item) => item.status === 'done' || item.status === 'cancelled'))
</script>

<template>
  <div class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-2 text-sm">
    <button type="button" class="flex w-full items-center gap-2 text-left" :aria-expanded="open" @click="open = !open">
      <span class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Tarefas</span>
      <span class="text-xs text-zinc-500">{{ done }} de {{ items.length }}{{ finished ? ' · concluídas' : '' }}</span>
      <span v-if="!open && current" class="min-w-0 flex-1 truncate text-xs text-emerald-300">{{ current.title }}</span>
      <span class="ml-auto text-xs text-zinc-500">{{ open ? '▾' : '▴' }}</span>
    </button>
    <ol v-if="open" class="scroll-thin mt-1.5 flex max-h-44 flex-col gap-1 overflow-y-auto">
      <li v-for="(item, index) in items" :key="index" class="flex items-start gap-2">
        <span
          class="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border text-[9px] leading-none"
          :class="{
            'border-zinc-600': item.status === 'pending',
            'border-emerald-400 bg-emerald-400/20': item.status === 'in_progress',
            'border-emerald-500 bg-emerald-500 text-zinc-950': item.status === 'done',
            'border-zinc-700 text-zinc-600': item.status === 'cancelled',
          }"
          aria-hidden="true"
          >{{ item.status === 'done' ? '✓' : item.status === 'cancelled' ? '–' : '' }}</span
        >
        <span
          class="min-w-0 flex-1 text-[13px] leading-snug"
          :class="{
            'text-zinc-300': item.status === 'pending',
            'font-medium text-emerald-200': item.status === 'in_progress',
            'text-zinc-500 line-through': item.status === 'done' || item.status === 'cancelled',
          }"
          >{{ item.title }}</span
        >
      </li>
    </ol>
  </div>
</template>
