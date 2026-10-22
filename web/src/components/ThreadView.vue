<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fullTime, providerLabel, tokens, usd } from '@/lib/format'
import { useAgentsStore } from '@/stores/agents'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useThreadStore, type IOutgoingFile } from '@/stores/thread'
import AgentAvatar from './AgentAvatar.vue'
import Composer from './Composer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Icon from './Icon.vue'
import TurnBubbles from './TurnBubbles.vue'

const router = useRouter()
const auth = useAuthStore()
const agents = useAgentsStore()
const conversations = useConversationsStore()
const thread = useThreadStore()

const scroller = ref<HTMLElement>()
const copied = ref(false)
const confirming = ref(false)
const deleting = ref(false)
const deleteError = ref<string>()

const header = computed(() => thread.header)
const agent = computed(() => agents.byId.get(header.value?.agentId ?? thread.draft?.agentId ?? ''))
const owner = computed(() => header.value?.metadata?.owner)
const shareUrl = computed(() => (header.value?.shared && header.value.shareId ? `${location.origin}/v1/shared/${header.value.shareId}` : ''))
const readOnly = computed(() => thread.liveSession === false)

watch(
  () => [thread.turns.length, thread.pending?.text.length, thread.pending?.tools.length],
  () => void nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight })),
)

async function send(text: string, files: IOutgoingFile[]) {
  const created = await thread.send(text, files)
  if (created) await router.replace(`/c/${created}`)
}

async function toggleShare() {
  if (!header.value) return
  await conversations.share(header.value.id, !header.value.shared)
}

async function copyShare() {
  await navigator.clipboard.writeText(shareUrl.value).catch(() => undefined)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

async function remove() {
  if (!header.value) return
  deleting.value = true
  deleteError.value = undefined
  try {
    await conversations.remove(header.value.id)
    confirming.value = false
    await router.push('/')
  } catch (error) {
    deleteError.value = error instanceof Error ? error.message : String(error)
  } finally {
    deleting.value = false
  }
}

/** Sessão nova com o mesmo agente, modelo e lane — o histórico anterior NÃO vai junto. */
async function continueFresh() {
  const source = header.value
  if (!source) return
  thread.startDraft({ agentId: source.agentId, mode: source.mode, tools: false, model: source.model })
  await router.push({ path: '/new', query: { from: source.id } })
}
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
      <RouterLink to="/" class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:hidden" title="Voltar"><Icon name="back" class="h-5 w-5" /></RouterLink>
      <AgentAvatar :name="agent?.name ?? header?.agentId ?? '?'" :provider="header?.provider ?? agent?.provider ?? 'claude'" size="sm" />
      <div class="min-w-0">
        <div class="truncate font-medium">{{ header?.title || agent?.name || 'Conversa' }}</div>
        <div class="truncate text-xs text-zinc-400">
          {{ agent?.name ?? header?.agentId }} · {{ providerLabel(header?.provider ?? agent?.provider ?? '') }} {{ header?.model }} ·
          {{ header?.mode === 'agent' ? 'Agents SDK' : 'chat' }}
          <template v-if="auth.isAdmin && owner"> · {{ owner.email ?? owner.id }}</template>
        </div>
      </div>
      <div v-if="header" class="ml-auto flex items-center gap-1">
        <span v-if="auth.isAdmin && header.costUsd !== undefined" class="mr-2 hidden text-xs text-zinc-400 sm:inline">{{ tokens(header.usage.totalTokens) }} tokens · {{ usd(header.costUsd) }}</span>
        <button class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800" :class="header.shared ? 'text-emerald-400' : 'text-zinc-400'" :title="header.shared ? 'Parar de compartilhar' : 'Compartilhar por link'" @click="toggleShare">
          <Icon name="share" class="h-5 w-5" />
        </button>
        <button class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-rose-300" title="Apagar histórico" @click="confirming = true">
          <Icon name="trash" class="h-5 w-5" />
        </button>
      </div>
    </header>

    <div v-if="shareUrl" class="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
      Aberta por link — quem tiver o endereço lê as perguntas e respostas.
      <code class="truncate text-emerald-300">{{ shareUrl }}</code>
      <button class="ml-auto flex items-center gap-1 hover:text-white" @click="copyShare"><Icon :name="copied ? 'check' : 'copy'" class="h-4 w-4" />{{ copied ? 'Copiado' : 'Copiar' }}</button>
    </div>

    <div ref="scroller" class="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgb(39_39_42/0.6)_1px,transparent_0)] [background-size:22px_22px] px-4 py-5">
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <p v-if="thread.loading" class="text-center text-sm text-zinc-500">Carregando conversa…</p>
        <p v-if="header" class="mx-auto rounded-full bg-zinc-900/80 px-3 py-1 text-xs text-zinc-400">Começou em {{ fullTime(header.createdAt) }}</p>
        <TurnBubbles v-for="turn in thread.turns" :key="`${turn.sessionId}-${turn.index}`" :turn="turn" :show-cost="auth.isAdmin" />
        <TurnBubbles v-if="thread.pending" :pending="thread.pending" :show-cost="auth.isAdmin" />
        <p v-if="thread.error" class="mx-auto text-sm text-rose-300">{{ thread.error }}</p>
      </div>
    </div>

    <ConfirmDialog
      :open="confirming"
      title="Apagar o histórico desta conversa?"
      :message="deleteError ?? 'Some da lista para todo mundo e não dá para desfazer. Uma sessão ainda viva no gateway não é encerrada.'"
      :busy="deleting"
      @confirm="remove"
      @cancel="confirming = false"
    />
    <div v-if="readOnly" class="flex flex-wrap items-center gap-3 border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3 text-sm text-zinc-400">
      <span>Esta sessão não está mais ativa no gateway (reinício ou expiração). O histórico fica, mas o agente já não tem o contexto.</span>
      <button class="ml-auto flex items-center gap-1.5 rounded-full bg-zinc-800 px-3 py-1.5 text-zinc-100 hover:bg-zinc-700" @click="continueFresh">
        <Icon name="refresh" class="h-4 w-4" /> Nova conversa com {{ agent?.name ?? 'o mesmo agente' }}
      </button>
    </div>
    <Composer v-else :sending="thread.sending" :disabled="thread.liveSession === undefined" @send="send" @stop="thread.stop" />
  </section>
</template>
