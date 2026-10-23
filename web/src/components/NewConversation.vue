<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { providerLabel } from '@/lib/format'
import type { TMode } from '@/lib/types'
import { useAgentsStore } from '@/stores/agents'
import { useThreadStore, type IOutgoingFile } from '@/stores/thread'
import AgentAvatar from './AgentAvatar.vue'
import Composer from './Composer.vue'
import Icon from './Icon.vue'
import TurnBubbles from './TurnBubbles.vue'

const route = useRoute()
const router = useRouter()
const agents = useAgentsStore()
const thread = useThreadStore()

const MODE_HINT: Record<string, string> = {
  chat: 'SDK normal do provider. Conversa, anexos e raciocínio.',
  chatTools: 'SDK normal + o loop de tools escrito à mão.',
  agent: 'Agents SDK oficial: o loop de tools é do SDK.',
}

const draft = computed(() => thread.draft)
const agent = computed(() => agents.byId.get(draft.value?.agentId ?? ''))

/** Os níveis que valem para o modelo escolhido: os dele no catálogo, ou os do agente quando o catálogo não sabe. */
const reasoningLevels = computed(() => {
  const current = agent.value
  if (!current || !draft.value?.model) return []
  return current.modelReasoning?.[draft.value.model] ?? current.reasoningEfforts ?? []
})

// Trocar para um modelo que não aceita o nível escolhido volta ao padrão, em vez de mandar um nível que seria ignorado.
watch(reasoningLevels, (levels) => {
  if (draft.value?.reasoning && !levels.includes(draft.value.reasoning)) draft.value.reasoning = undefined
})

/**
 * Rascunho novo ao entrar — a não ser que já exista um SEM sessão (o "nova conversa com o mesmo
 * agente" de uma conversa encerrada, que chega aqui com agente e modelo já escolhidos).
 */
function ensureDraft() {
  const found = agents.byId.get(String(route.query.agent ?? ''))
  const asked = found?.role === 'subagent' ? undefined : found
  if (asked && thread.draft?.agentId !== asked.id) return pick(asked.id, true)

  const first = agents.conversable[0]
  if ((thread.draft && !thread.sessionId && agents.byId.has(thread.draft.agentId)) || !first) return
  thread.startDraft({ agentId: first.id, mode: first.modes[0] ?? 'chat', tools: false, model: first.models[0] })
}

onMounted(ensureDraft)
watch(() => agents.list, ensureDraft)

function pick(id: string, fresh = false) {
  const next = agents.byId.get(id)
  if (!next) return
  const previous = fresh ? undefined : thread.draft
  const mode = previous && next.modes.includes(previous.mode) ? previous.mode : (next.modes[0] ?? 'chat')
  thread.startDraft({ agentId: id, mode, tools: !!previous?.tools && next.allowedTools.length > 0, model: next.models[0] })
}

function setMode(mode: TMode, tools: boolean) {
  if (thread.draft) thread.draft = { ...thread.draft, mode, tools }
}

async function send(text: string, files: IOutgoingFile[]) {
  const created = await thread.send(text, files)
  if (created) await router.replace(`/c/${created}`)
}
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-3">
      <RouterLink to="/" class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:hidden" title="Voltar"><Icon name="back" class="h-5 w-5" /></RouterLink>
      <h2 class="font-medium">Nova conversa</h2>
    </header>

    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-5">
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <template v-if="!thread.turns.length && !thread.pending">
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              v-for="option in agents.conversable"
              :key="option.id"
              class="flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors"
              :class="option.id === draft?.agentId ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-800 hover:bg-zinc-900'"
              @click="pick(option.id)"
            >
              <AgentAvatar :name="option.name" :provider="option.provider" size="sm" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ option.name }}</span>
                <span class="block truncate text-xs text-zinc-400">{{ providerLabel(option.provider) }} · {{ option.allowedTools.join(', ') || 'sem tools' }}</span>
              </span>
              <span v-if="!option.builtIn" class="ml-auto rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">criado</span>
            </button>
          </div>

          <div v-if="agent && draft" class="grid gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <span class="mb-1.5 block text-xs font-medium text-zinc-400">Lane</span>
              <div class="flex flex-wrap gap-1.5">
                <button v-if="agent.modes.includes('chat')" class="rounded-full border px-3 py-1 text-sm" :class="draft.mode === 'chat' && !draft.tools ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700'" @click="setMode('chat', false)">Chat</button>
                <button v-if="agent.modes.includes('chat') && agent.allowedTools.length" class="rounded-full border px-3 py-1 text-sm" :class="draft.mode === 'chat' && draft.tools ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700'" @click="setMode('chat', true)">Chat + tools</button>
                <button v-if="agent.modes.includes('agent')" class="rounded-full border px-3 py-1 text-sm" :class="draft.mode === 'agent' ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700'" @click="setMode('agent', false)">Agents SDK</button>
              </div>
              <p class="mt-1.5 text-xs text-zinc-500">{{ MODE_HINT[draft.mode === 'chat' && draft.tools ? 'chatTools' : draft.mode] }}</p>
            </div>
            <label class="text-xs font-medium text-zinc-400">
              Modelo
              <select v-model="draft.model" class="mt-1 w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100">
                <option v-for="model in agent.models" :key="model" :value="model">{{ model }}{{ agent.pricing[model] ? ` — $${agent.pricing[model].output}/1M saída` : '' }}</option>
              </select>
            </label>
            <label v-if="reasoningLevels.length" class="text-xs font-medium text-zinc-400">
              Raciocínio
              <select v-model="draft.reasoning" class="mt-1 w-full rounded-lg bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100">
                <option :value="undefined">padrão</option>
                <option v-for="effort in reasoningLevels" :key="effort" :value="effort">{{ effort }}</option>
              </select>
            </label>
          </div>
        </template>

        <TurnBubbles v-for="turn in thread.turns" :key="turn.index" :turn="turn" :show-cost="false" />
        <TurnBubbles v-if="thread.pending" :pending="thread.pending" :show-cost="false" />
        <p v-if="thread.error" class="mx-auto text-sm text-rose-300">{{ thread.error }}</p>
      </div>
    </div>

    <Composer :sending="thread.sending" :disabled="!agent" :placeholder="agent ? `Mensagem para ${agent.name}` : 'Escolha um agente'" @send="send" @stop="thread.stop" />
  </section>
</template>
