<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '@/lib/api'
import type { IConversation } from '@/lib/types'
import { useRouter } from 'vue-router'
import { contextMeter } from '@/lib/contextMeter'
import { fullTime, tokens, usd } from '@/lib/format'
import { useAgentsStore } from '@/stores/agents'
import { useProtocolsStore } from '@/stores/protocols'
import { useAuthStore } from '@/stores/auth'
import { useConversationsStore } from '@/stores/conversations'
import { useThreadStore, type IOutgoingFile } from '@/stores/thread'
import AgentAvatar from './AgentAvatar.vue'
import Composer from './Composer.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import Icon from './Icon.vue'
import SessionTuner from './SessionTuner.vue'
import TurnBubbles from './TurnBubbles.vue'

const router = useRouter()
const auth = useAuthStore()
const agents = useAgentsStore()
const protocols = useProtocolsStore()
const conversations = useConversationsStore()
const thread = useThreadStore()

const scroller = ref<HTMLElement>()
const copied = ref(false)
const confirming = ref(false)
const deleting = ref(false)
const deleteError = ref<string>()
/** Falha de compartilhar ou de copiar o link: aparece numa faixa, em vez de morrer calada. */
const actionError = ref<string>()

const header = computed(() => thread.header)
const agent = computed(() => agents.byId.get(header.value?.agentId ?? thread.draft?.agentId ?? ''))
const owner = computed(() => header.value?.metadata?.owner)
const shareUrl = computed(() => (header.value?.shared && header.value.shareId ? `${location.origin}/v1/shared/${header.value.shareId}` : ''))
const readOnly = computed(() => thread.liveSession === false)

/** De quem esta conversa é filha (delegada por outro agente) e as filhas que ela abriu. */
const parentId = computed(() => (typeof header.value?.metadata?.delegatedBy === 'string' ? header.value.metadata.delegatedBy : undefined))
const parentAgent = computed(() => {
  const from = header.value?.metadata?.delegatedFrom
  return typeof from === 'string' ? (agents.byId.get(from)?.name ?? from) : 'outro agente'
})
const children = ref<IConversation[]>([])
watch(
  () => [header.value?.id, thread.turns.length] as const,
  async ([id]) => {
    if (!id) return (children.value = [])
    const page = await api<{ sessions: IConversation[] }>('/conversations', { query: { delegatedBy: id, limit: 50 } }).catch(() => ({ sessions: [] }))
    if (id === header.value?.id) children.value = page.sessions
  },
  { immediate: true },
)
const childTokens = computed(() => children.value.reduce((total, child) => total + (child.usage.totalTokens ?? 0), 0))
const childCost = computed(() => (children.value.some((child) => child.costUsd !== undefined) ? children.value.reduce((total, child) => total + (child.costUsd ?? 0), 0) : undefined))
/** O provider e o modelo em vigor: os da sessão viva (podem ter trocado), senão os da conversa. */
const currentModel = computed(() => thread.session?.model ?? header.value?.model)
const currentProvider = computed(() => thread.session?.provider ?? header.value?.provider ?? agent.value?.providers[0]?.id ?? '')

/**
 * ⚖️ O CONTEXTO EM USO é o da última chamada ao modelo (`contextTokens`), não a soma do turno: o do turno em
 * andamento, senão o do último turno que o informou, senão o da conversa.
 */
const contextUsed = computed(() => {
  if (thread.pending?.usage?.contextTokens) return thread.pending.usage.contextTokens
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const value = thread.turns[index].usage?.contextTokens
    if (value) return value
  }
  return header.value?.usage.contextTokens
})
const contextWindow = computed(() => agent.value?.providers.find((provider) => provider.id === currentProvider.value)?.contextLength?.[currentModel.value ?? ''])
const context = computed(() => contextMeter(contextUsed.value, contextWindow.value))

/**
 * O aviso antes do turno que mudou de provider, de modelo ou de nível em relação ao anterior. Só compara
 * turnos que registram o modelo (os antigos não registram); o provider ausente é o da conversa.
 */
function switchBefore(index: number): string | undefined {
  const turn = thread.turns[index]
  const previous = thread.turns[index - 1]
  if (!turn?.model || !previous?.model) return undefined
  const fallback = header.value?.provider ?? ''
  const provider = turn.provider ?? fallback
  const providerChanged = provider !== (previous.provider ?? fallback)
  if (!providerChanged && turn.model === previous.model && (turn.effort ?? '') === (previous.effort ?? '')) return undefined
  return `trocou para ${providerChanged ? `${protocols.providerName(provider)} · ` : ''}${turn.model}${turn.effort ? ` · ${turn.effort}` : ''}`
}

watch(
  () => [thread.turns.length, thread.pending?.text.length, thread.pending?.tools.length],
  () => void nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight })),
)

async function send(text: string, files: IOutgoingFile[], settle: (ok: boolean) => void) {
  const { ok, created } = await thread.send(text, files)
  settle(ok)
  if (created) await router.replace(`/c/${created}`)
}

async function toggleShare() {
  if (!header.value) return
  actionError.value = undefined
  try {
    await conversations.share(header.value.id, !header.value.shared)
  } catch (error) {
    actionError.value = `Não foi possível ${header.value.shared ? 'parar de compartilhar' : 'compartilhar'}: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function copyShare() {
  actionError.value = undefined
  try {
    // ⚠️ `navigator.clipboard` some fora de HTTPS e pode recusar a permissão: só é "Copiado" se a escrita deu certo.
    if (!navigator.clipboard) throw new Error('o navegador não permite copiar aqui')
    await navigator.clipboard.writeText(shareUrl.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch (error) {
    copied.value = false
    actionError.value = `Não foi possível copiar o link: ${error instanceof Error ? error.message : String(error)}`
  }
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
  thread.startDraft({ agentId: source.agentId, mode: source.mode, tools: false, provider: source.provider, model: source.model })
  await router.push({ path: '/new', query: { from: source.id } })
}
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
      <RouterLink to="/" class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:hidden" title="Voltar"><Icon name="back" class="h-5 w-5" /></RouterLink>
      <AgentAvatar :name="agent?.name ?? header?.agentId ?? '?'" :provider="currentProvider || 'claude'" size="sm" />
      <div class="min-w-0">
        <div class="truncate font-medium">{{ header?.title || agent?.name || 'Conversa' }}</div>
        <div class="truncate text-xs text-zinc-400">
          {{ agent?.name ?? header?.agentId }} · {{ protocols.providerName(currentProvider) }} {{ currentModel }}<template v-if="thread.session?.reasoning"> ({{ thread.session.reasoning }})</template> ·
          {{ header?.mode === 'agent' ? 'Agents SDK' : 'chat' }}
          <template v-if="auth.isAdmin && owner"> · {{ owner.email ?? owner.id }}</template>
        </div>
      </div>
      <div v-if="header || context" class="ml-auto flex items-center gap-1">
        <div v-if="context" class="mr-2 grid h-8 w-8 place-items-center" :title="`Contexto ${context.label}`">
          <svg v-if="context.percent !== undefined" viewBox="0 0 32 32" class="col-start-1 row-start-1 h-8 w-8 -rotate-90">
            <circle cx="16" cy="16" r="13" fill="none" stroke-width="3" class="stroke-zinc-800" />
            <circle cx="16" cy="16" r="13" fill="none" stroke-width="3" stroke-linecap="round" pathLength="100" :stroke-dasharray="`${context.percent} 100`" :class="context.warn ? 'stroke-amber-400' : 'stroke-emerald-500'" />
          </svg>
          <span class="col-start-1 row-start-1 text-[9px] tabular-nums" :class="context.warn ? 'text-amber-300' : 'text-zinc-400'">{{ context.short }}</span>
        </div>
        <template v-if="header">
          <span v-if="auth.isAdmin && header.costUsd !== undefined" class="mr-2 hidden text-xs text-zinc-400 sm:inline">{{ tokens(header.usage.totalTokens) }} tokens · {{ header.costIsFloor ? '≥ ' : '' }}{{ usd(header.costUsd) }}</span>
          <button class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800" :class="header.shared ? 'text-emerald-400' : 'text-zinc-400'" :title="header.shared ? 'Parar de compartilhar' : 'Compartilhar por link'" @click="toggleShare">
            <Icon name="share" class="h-5 w-5" />
          </button>
          <button class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-rose-300" title="Apagar histórico" @click="confirming = true">
            <Icon name="trash" class="h-5 w-5" />
          </button>
        </template>
      </div>
    </header>

    <div v-if="parentId" class="flex items-center gap-2 border-b border-violet-500/20 bg-violet-500/10 px-4 py-2 text-xs text-violet-200">
      Delegada por {{ parentAgent }}.
      <RouterLink :to="`/c/${parentId}`" class="ml-auto hover:text-white">Abrir a conversa original →</RouterLink>
    </div>
    <div v-if="children.length" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-1.5 text-xs text-zinc-400">
      <span>{{ children.length }} delegaç{{ children.length === 1 ? 'ão' : 'ões' }} · {{ tokens(childTokens) }} tokens<template v-if="auth.isAdmin && childCost !== undefined"> · {{ usd(childCost) }}</template></span>
      <RouterLink v-for="child in children" :key="child.id" :to="`/c/${child.id}`" class="rounded-full bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700">{{ agents.byId.get(child.agentId)?.name ?? child.agentId }}</RouterLink>
    </div>

    <div v-if="actionError" class="flex items-center gap-2 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
      {{ actionError }}
      <button class="ml-auto hover:text-white" title="Fechar" @click="actionError = undefined"><Icon name="x" class="h-4 w-4" /></button>
    </div>

    <div v-if="shareUrl" class="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
      Aberta por link — quem tiver o endereço lê as perguntas e respostas.
      <code class="truncate text-emerald-300">{{ shareUrl }}</code>
      <button class="ml-auto flex items-center gap-1 hover:text-white" @click="copyShare"><Icon :name="copied ? 'check' : 'copy'" class="h-4 w-4" />{{ copied ? 'Copiado' : 'Copiar' }}</button>
    </div>

    <div ref="scroller" class="scroll-thin min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgb(39_39_42/0.6)_1px,transparent_0)] [background-size:22px_22px] px-4 py-5">
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <p v-if="thread.loading" class="text-center text-sm text-zinc-500">Carregando conversa…</p>
        <p v-if="header" class="mx-auto rounded-full bg-zinc-900/80 px-3 py-1 text-xs text-zinc-400">Começou em {{ fullTime(header.createdAt) }}</p>
        <template v-for="(turn, index) in thread.turns" :key="`${turn.sessionId}-${turn.index}`">
          <p v-if="switchBefore(index)" class="mx-auto rounded-full border border-zinc-800 px-3 py-0.5 font-mono text-[11px] text-zinc-500">{{ switchBefore(index) }}</p>
          <TurnBubbles :turn="turn" :show-cost="auth.isAdmin" />
        </template>
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
    <SessionTuner v-if="!readOnly && thread.liveSession && agent" :agent="agent" :mode="header?.mode" :fallback="{ provider: header?.provider, model: header?.model }" />
    <Composer v-if="!readOnly" :sending="thread.sending" :disabled="thread.liveSession === undefined" @send="send" @stop="thread.stop" />
  </section>
</template>
