<script setup lang="ts">
import { computed } from 'vue'
import { CLASSIFICATION_COLOR, CLASSIFICATION_LABEL, shortTime, tokens, usd } from '@/lib/format'
import { renderMarkdown } from '@/lib/markdown'
import type { ITurn } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import type { IPendingTurn } from '@/stores/thread'

/** Um turno vira dois balões: a pergunta (direita) e a resposta do agente (esquerda). */
const props = defineProps<{ turn?: ITurn; pending?: IPendingTurn; showCost: boolean }>()
const agents = useAgentsStore()

const request = computed(() => props.turn?.request ?? props.pending?.request ?? '')
const files = computed(() => props.turn?.files?.length ?? props.pending?.files ?? 0)
const text = computed(() => props.turn?.text ?? props.pending?.text ?? '')
const reasoning = computed(() => props.turn?.reasoning ?? props.pending?.reasoning ?? '')
const tools = computed(() => {
  if (props.pending) return props.pending.tools
  return (props.turn?.toolCalls ?? []).map((call) => ({ tool: call.tool, status: call.error ? ('error' as const) : ('done' as const), message: call.error, delegation: delegationOf(call) }))
})

/**
 * A delegação de um turno: a quem foi e a conversa filha. O resultado vem como o SDK o entregou (texto,
 * blocos ou JSON aninhado), então o id é procurado no texto serializado.
 */
const delegated = (tool: object) => (tool as { delegation?: { agentId?: string; sessionId: string } }).delegation

function delegationOf(call: { tool: string; args?: unknown; result?: unknown }): { agentId?: string; sessionId: string } | undefined {
  if (!call.tool.endsWith('delegate_to_agent')) return undefined
  const serialized = JSON.stringify(call.result ?? '')
  const sessionId = /sessionId\\*"\s*:\s*\\*"([^"\\]+)/.exec(serialized)?.[1]
  if (!sessionId) return undefined
  const agentId = (call.args as { agentId?: string } | undefined)?.agentId ?? /agentId\\*"\s*:\s*\\*"([^"\\]+)/.exec(serialized)?.[1]
  return { agentId, sessionId }
}
const warnings = computed(() => props.turn?.warnings ?? props.pending?.warnings ?? [])
const aborted = computed(() => props.turn?.aborted ?? props.pending?.aborted ?? false)
const error = computed(() => props.turn?.error ?? props.pending?.error)
const usage = computed(() => props.turn?.usage ?? props.pending?.usage)
const thinking = computed(() => !!props.pending && !text.value && !props.pending.error)
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="request || files" class="ml-auto max-w-[78%] rounded-2xl rounded-br-md bg-emerald-600/90 px-3.5 py-2 text-sm whitespace-pre-wrap text-white shadow">
      {{ request }}
      <div v-if="files" class="mt-1 text-xs text-emerald-100/80">📎 {{ files }} anexo(s)</div>
      <div v-if="turn" class="mt-0.5 text-right text-[11px] text-emerald-100/70">{{ shortTime(turn.at) }}</div>
    </div>

    <div class="mr-auto flex max-w-[85%] flex-col gap-1.5">
      <details v-if="reasoning" class="w-fit max-w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400">
        <summary class="cursor-pointer select-none">Raciocínio</summary>
        <p class="mt-1 whitespace-pre-wrap">{{ reasoning }}</p>
      </details>

      <div v-if="tools.length" class="flex flex-wrap gap-1.5">
        <span
          v-for="(tool, index) in tools"
          :key="index"
          class="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
          :class="{
            'border-sky-500/40 bg-sky-500/10 text-sky-300': tool.status === 'running',
            'border-zinc-700 bg-zinc-800/70 text-zinc-300': tool.status === 'done',
            'border-rose-500/40 bg-rose-500/10 text-rose-300': tool.status === 'error',
          }"
          :title="tool.message ?? tool.tool"
        >
          <span v-if="tool.status === 'running'" class="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
          <span v-else>{{ tool.status === 'done' ? '✓' : '✕' }}</span>
          <RouterLink v-if="delegated(tool)" :to="`/c/${delegated(tool)!.sessionId}`" class="underline-offset-2 hover:underline">
            Delegou a {{ agents.byId.get(delegated(tool)!.agentId ?? '')?.name ?? delegated(tool)!.agentId ?? 'outro agente' }} →
          </RouterLink>
          <template v-else>{{ agents.toolLabel(tool.tool) }}</template>
        </span>
      </div>

      <div v-if="text || thinking || error || aborted" class="rounded-2xl rounded-bl-md bg-zinc-800/90 px-3.5 py-2 text-sm leading-relaxed shadow">
        <div v-if="thinking" class="flex h-5 items-center gap-1">
          <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
          <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
          <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown escapa antes de marcar -->
        <div v-if="text" class="prose-agent break-words" v-html="renderMarkdown(text)" />
        <p v-if="error" class="mt-1 text-sm text-rose-300">Algo deu errado: {{ error }}</p>
        <p v-if="aborted" class="mt-1 text-xs text-zinc-400 italic">Interrompido.</p>
        <div v-if="turn" class="mt-1 flex items-center justify-end gap-2 text-[11px] text-zinc-500">
          <span v-if="turn.classification" class="flex items-center gap-1" :title="CLASSIFICATION_LABEL[turn.classification]">
            <span class="h-2 w-2 rounded-full" :class="CLASSIFICATION_COLOR[turn.classification]" />
          </span>
          <span v-if="usage?.totalTokens">{{ tokens(usage.totalTokens) }} tokens</span>
          <span v-if="showCost && turn.costUsd !== undefined">{{ usd(turn.costUsd) }}</span>
          <span v-if="turn.durationMs">{{ (turn.durationMs / 1000).toFixed(1) }}s</span>
          <span>{{ shortTime(turn.at) }}</span>
        </div>
      </div>

      <p v-for="(warning, index) in warnings" :key="index" class="text-xs text-amber-300/80">⚠ {{ warning }}</p>
    </div>
  </div>
</template>
