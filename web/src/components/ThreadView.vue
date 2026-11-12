<script setup lang="ts">
  import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
  import { api } from '@/lib/api'
  import { useStickToBottom } from '@/composables/useStickToBottom'
  import type { IConversation, TMode } from '@/lib/types'
  import { useRouter } from 'vue-router'
  import { coreAgentName } from '@/lib/builder'
  import { useAgentCommands } from '@/lib/commands'
  import { contextMeter } from '@/lib/contextMeter'
  import { effortLabel, fullTime } from '@/lib/format'
  import { useAgentsStore } from '@/stores/agents'
  import { useProtocolsStore } from '@/stores/protocols'
  import { useConversationsStore } from '@/stores/conversations'
  import DelegationsPanel from './DelegationsPanel.vue'
  import { usePopover } from '@/lib/popover'
  import { useProjectsStore } from '@/stores/projects'
  import { openCount, type IConversationPanel } from '@/lib/conversationPanel'
  import { useThreadStore, type IOutgoingFile } from '@/stores/thread'
  import AgentAvatar from './AgentAvatar.vue'
  import Composer from './Composer.vue'
  import ConfirmDialog from './ConfirmDialog.vue'
  import Icon from './Icon.vue'
  import PanelToggle from './PanelToggle.vue'
  import TokensMenu from './TokensMenu.vue'
  import SessionTuner from './SessionTuner.vue'
  import TodoPanel from './TodoPanel.vue'
  import WatchesPanel from './WatchesPanel.vue'
  import TurnBubbles from './TurnBubbles.vue'
  import { copyText } from '@/lib/clipboard'

  /**
   * `embedded`: dentro de outra tela (a guia Construir) — sem voltar, compartilhar nem "comece uma nova"; apagar avisa quem
   * embute. `agentId` e `mode`: o que quem embute já sabe, para o cabeçalho antes do primeiro turno gravado.
   */
  const props = defineProps<{ embedded?: boolean; agentId?: string; mode?: TMode }>()
  const emit = defineEmits<{ removed: [] }>()
  const router = useRouter()
  const agents = useAgentsStore()
  const protocols = useProtocolsStore()
  const conversations = useConversationsStore()
  const thread = useThreadStore()

  const projects = useProjectsStore()

  const scroller = ref<HTMLElement>()
  const copied = ref(false)
  const confirming = ref(false)
  const deleting = ref(false)
  const deleteError = ref<string>()
  /** Falha de compartilhar ou de copiar o link: aparece numa faixa, em vez de morrer calada. */
  const actionError = ref<string>()

  const header = computed(() => thread.header)

  /** As alterações (o painel tipo IDE): só numa conversa aberta num repositório. O diff (e o destaque) só carrega ao abrir. */
  const ChangesPanel = defineAsyncComponent(() => import('./ChangesPanel.vue'))
  const ConversationPanel = defineAsyncComponent(() => import('./ConversationPanel.vue'))
  /** O Painel da conversa: o selo do ícone (itens em aberto) vale com o painel fechado; o painel relê quando abre, quando o turno acaba e quando o agente mexe nele. */
  const panelOpen = ref(false)
  const panelCount = ref<number>()
  const panelRefresh = ref(0)
  async function loadPanelCount() {
    const id = header.value?.id
    if (!id) return void (panelCount.value = undefined)
    const result = await api<IConversationPanel>(`/conversations/${encodeURIComponent(id)}/panel`).catch(() => undefined)
    if (id === header.value?.id) panelCount.value = result ? openCount(result) : undefined
  }
  watch(
    () => header.value?.id,
    () => void loadPanelCount(),
    { immediate: true },
  )
  function refreshPanel() {
    panelRefresh.value += 1
    if (!panelOpen.value) void loadPanelCount()
  }
  // O agente mexeu no painel (resultado da ferramenta no turno ao vivo)…
  watch(() => thread.panelVersion, refreshPanel)
  // …ou o turno acabou (pode ter mexido sem a gente ver o evento).
  watch(
    () => !!thread.pending,
    (running, before) => {
      if (before && !running) refreshPanel()
    },
  )
  const changesOpen = ref(false)
  const changesCount = ref<number>()
  const changesRefresh = ref(0)
  const inRepository = computed(() => typeof header.value?.metadata?.repository === 'string' && !!thread.sessionId)
  async function loadChangesCount() {
    if (!inRepository.value || !thread.sessionId) return void (changesCount.value = undefined)
    const result = await api<{ files: unknown[] }>(`/sessions/${encodeURIComponent(thread.sessionId)}/changes`, { query: { scope: 'conversation' } }).catch(() => undefined)
    changesCount.value = result?.files.length
  }
  watch(inRepository, () => void loadChangesCount(), { immediate: true })
  // Terminou um turno: o agente pode ter mudado arquivos (a contagem e o painel aberto se atualizam).
  watch(
    () => !!thread.pending,
    (running, before) => {
      if (before && !running) {
        changesRefresh.value += 1
        void loadChangesCount()
      }
    },
  )
  const agent = computed(() => agents.byId.get(header.value?.agentId ?? thread.draft?.agentId ?? ''))
  /** O nome do agente — o do core (o construtor) não está na lista de agentes. */
  const agentName = computed(() => agent.value?.name ?? coreAgentName(header.value?.agentId ?? thread.agentId ?? props.agentId) ?? header.value?.agentId)
  const owner = computed(() => header.value?.metadata?.owner)
  const shareUrl = computed(() => (header.value?.shared && header.value.shareId ? `${location.origin}/s/${header.value.shareId}` : ''))
  /** Os `/commands` que a pessoa pode usar com este agente (o autocompletar da caixa). */
  // ⚠️ Pelo agente da CONVERSA (o cabeçalho), não só pela lista de agentes: ela vem recortada pelo projeto atual, e a
  // conversa pode ser de outro projeto. Quem diz o que a pessoa pode usar é o servidor.
  const commands = useAgentCommands(
    computed(() => agent.value?.id ?? header.value?.agentId ?? thread.agentId),
    // Os documentos do `/` são os do projeto DA CONVERSA (o do cabeçalho); conversa nova, o projeto atual.
    computed(() => (typeof header.value?.metadata?.project === 'string' ? header.value.metadata.project : (projects.current ?? undefined))),
  )
  /** A sessão não está viva, mas a conversa volta ao enviar (o gateway a retoma do histórico gravado). */
  // Com um turno rodando a conversa não está encerrada, mesmo que o servidor ainda não a tenha marcado viva de novo.
  const resumable = computed(() => thread.liveSession === false && !thread.pending)

  /** De quem esta conversa é filha (delegada por outro agente) e as filhas que ela abriu. */
  const parentId = computed(() => (typeof header.value?.metadata?.delegatedBy === 'string' ? header.value.metadata.delegatedBy : undefined))
  const parentAgent = computed(() => {
    const from = header.value?.metadata?.delegatedFrom
    return typeof from === 'string' ? (agents.byId.get(from)?.name ?? from) : 'outro agente'
  })
  const children = ref<IConversation[]>([])
  // Relida também quando uma conversa começa ou para de rodar: a filha contactada no meio do turno aparece e sobe na hora.
  watch(
    () => [header.value?.id, thread.turns.length, conversations.running] as const,
    async ([id]) => {
      if (!id) return (children.value = [])
      const page = await api<{ sessions: IConversation[] }>('/conversations', { query: { delegatedBy: id, limit: 50 } }).catch(() => ({ sessions: [] }))
      if (id === header.value?.id) children.value = page.sessions
    },
    { immediate: true },
  )
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
  // A janela do modelo sem listagem (a assinatura) o servidor aprende no primeiro turno: os agentes são relidos para o anel aparecer.
  watch(contextUsed, (used) => {
    if (used && contextWindow.value === undefined && agent.value) void agents.load().catch(() => undefined)
  })

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
    return `trocou para ${providerChanged ? `${protocols.providerName(provider)} · ` : ''}${turn.model}${turn.effort ? ` · raciocínio ${effortLabel(turn.effort).toLowerCase()}` : ''}`
  }

  // ⚖️ A rolagem segue o fim só enquanto a pessoa está nele (ver `useStickToBottom`).
  const { pinned, unseen, onScroll, toBottom, grew } = useStickToBottom(scroller)
  watch(
    () => [thread.turns.length, thread.pending?.text.length, thread.pending?.tools.length],
    () => grew(),
  )
  // Outra conversa aberta: começa no fim, seguindo.
  watch(
    () => thread.sessionId,
    () => toBottom(),
  )

  async function send(text: string, files: IOutgoingFile[], settle: (ok: boolean) => void) {
    // Quem envia quer ver a resposta: a rolagem volta a seguir o fim.
    toBottom()
    const { ok, created } = await thread.send(text, files)
    settle(ok)
    if (created) await router.replace(`/c/${created}`)
  }

  /**
   * Compactar à mão: com a conversa viva e já com um turno, numa lane que o gateway compacta (Codex e Antigravity compactam
   * sozinhos). ⚖️ A QUALQUER MOMENTO, não só da metade da janela em diante: dá para testar (e mostrar) antes do limite.
   */
  const compacting = ref(false)
  const canCompact = computed(() => thread.liveSession === true && !thread.session?.compactsItself && (!!thread.session?.compactNext || thread.turns.length > 0))
  /** O aviso de quando a compactação ficou para a próxima rodada (a conversa estava respondendo). */
  const compactNotice = ref<string>()
  async function compactNow() {
    compacting.value = true
    actionError.value = undefined
    compactNotice.value = undefined
    try {
      const outcome = await thread.compact()
      if (outcome === 'next-turn') compactNotice.value = 'A conversa está respondendo: o contexto é compactado no começo da próxima rodada.'
    } catch (error) {
      actionError.value = `Não foi possível compactar: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      compacting.value = false
    }
  }

  /**
   * ⚖️ NO CELULAR, as ações do cabeçalho (painel, alterações, compactar, compartilhar, arquivar, apagar) moram num menu
   * "⋯", no estilo do menu da conta: o título ganha o espaço. O medidor de contexto continua à vista.
   */
  const { open: menuOpen, root: menuRoot } = usePopover()
  function fromMenu(action: () => unknown) {
    menuOpen.value = false
    void action()
  }
  async function archiveConversation() {
    if (!header.value) return
    await conversations.archive(header.value.id)
    if (!props.embedded) await router.push('/')
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
      // Só é "Copiado" se a escrita deu certo (ver `copyText`: fora de HTTPS vai pelo caminho antigo).
      await copyText(shareUrl.value)
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
      if (props.embedded) emit('removed')
      else await router.push('/')
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
    const repository = typeof source.metadata?.repository === 'string' ? source.metadata.repository : undefined
    const worktree = typeof source.metadata?.worktree === 'string' ? source.metadata.worktree : undefined
    thread.startDraft({ agentId: source.agentId, mode: source.mode, tools: false, provider: source.provider, model: source.model, repository, worktree })
    await router.push({ path: '/new', query: { from: source.id } })
  }
</script>

<template>
  <section class="flex h-full flex-col">
    <header class="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
      <RouterLink v-if="!embedded" to="/" class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:hidden" title="Voltar">
        <Icon name="back" class="h-5 w-5" />
      </RouterLink>
      <AgentAvatar :name="agentName ?? '?'" :provider="currentProvider || 'claude'" size="sm" />
      <div class="min-w-0">
        <div class="truncate font-medium">{{ header?.title || agentName || 'Conversa' }}</div>
        <div class="truncate text-xs text-zinc-400">
          {{ agentName }} · {{ protocols.providerName(currentProvider) }} {{ currentModel }}
          <template v-if="thread.session?.reasoning">· raciocínio {{ effortLabel(thread.session.reasoning).toLowerCase() }}</template>
          <template v-if="typeof header?.metadata?.repository === 'string'">
            · {{ header.metadata.repository }}
            <template v-if="typeof header.metadata.worktree === 'string'">/ {{ header.metadata.worktree }}</template>
          </template>
          <template v-if="projects.manages && owner">· {{ owner.email ?? owner.id }}</template>
        </div>
      </div>
      <div v-if="header || context" class="ml-auto flex items-center gap-1">
        <div v-if="context" class="mr-2 grid h-8 w-8 place-items-center" :title="`Contexto da conversa: ${context.label.replace(' / ', ' de ').replace(' usados', '')} tokens`">
          <svg v-if="context.percent !== undefined" viewBox="0 0 32 32" class="col-start-1 row-start-1 h-8 w-8 -rotate-90">
            <circle cx="16" cy="16" r="13" fill="none" stroke-width="3" class="stroke-zinc-800" />
            <circle
              cx="16"
              cy="16"
              r="13"
              fill="none"
              stroke-width="3"
              stroke-linecap="round"
              pathLength="100"
              :stroke-dasharray="`${context.percent} 100`"
              :class="context.warn ? 'stroke-amber-400' : 'stroke-emerald-500'"
            />
          </svg>
          <span class="col-start-1 row-start-1 text-[9px] tabular-nums" :class="context.warn ? 'text-amber-300' : 'text-zinc-400'">{{ context.short }}</span>
        </div>
        <button
          v-if="canCompact"
          class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800 disabled:hover:bg-transparent max-md:hidden"
          :class="thread.session?.compactNext ? 'text-zinc-500' : 'text-amber-300'"
          :disabled="thread.session?.compactNext || compacting"
          :title="thread.session?.compactNext ? 'A próxima mensagem começa com um resumo da conversa' : 'Compactar: resumir a conversa e recomeçar com o resumo, na próxima mensagem'"
          :aria-label="thread.session?.compactNext ? 'Compacta na próxima mensagem' : 'Compactar o contexto'"
          @click="compactNow"
        >
          <Icon name="compress" class="h-5 w-5" />
        </button>
        <template v-if="header">
          <TokensMenu
            v-if="header.usage.totalTokens"
            class="max-md:hidden"
            :usage="header.usage"
            :cost-usd="projects.manages ? header.costUsd : undefined"
            :cost-is-floor="header.costIsFloor"
            :turns="header.turns"
            :context="context"
          />
          <button
            v-if="inRepository"
            class="relative grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 max-md:hidden"
            :title="changesCount ? `O que o agente mudou nesta conversa: ${changesCount}` : 'O que o agente mudou nesta conversa'"
            data-test="changes-toggle"
            @click="changesOpen = true"
          >
            <Icon name="git" class="h-5 w-5" />
            <span
              v-if="changesCount"
              class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-emerald-500/20 px-1 text-center text-[10px] leading-4 text-emerald-300"
            >
              {{ changesCount }}
            </span>
          </button>
          <PanelToggle class="max-md:hidden" :count="panelCount" :active="panelOpen" @click="panelOpen = !panelOpen" />
          <button
            v-if="!embedded"
            class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800 max-md:hidden"
            :class="header.shared ? 'text-emerald-400' : 'text-zinc-400'"
            :title="header.shared ? 'Parar de compartilhar' : 'Compartilhar por link'"
            @click="toggleShare"
          >
            <Icon name="share" class="h-5 w-5" />
          </button>
          <button
            class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-rose-300 max-md:hidden"
            title="Apagar histórico"
            @click="confirming = true"
          >
            <Icon name="trash" class="h-5 w-5" />
          </button>
          <div ref="menuRoot" class="relative md:hidden">
            <button
              type="button"
              class="relative grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800"
              title="Mais ações"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              data-test="thread-menu"
              @click="menuOpen = !menuOpen"
            >
              <Icon name="more" class="h-5 w-5" />
              <span v-if="panelCount" class="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-emerald-500/20 px-1 text-center text-[10px] leading-4 text-emerald-300">
                {{ panelCount }}
              </span>
            </button>
            <div
              v-if="menuOpen"
              role="menu"
              class="absolute top-full right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
              data-test="thread-menu-items"
            >
              <button
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                @click="fromMenu(() => (panelOpen = !panelOpen))"
              >
                <Icon name="panel" class="h-4 w-4 text-zinc-400" />
                Painel da conversa
                <span v-if="panelCount" class="ml-auto rounded-full bg-emerald-500/20 px-1.5 text-[10px] leading-4 text-emerald-300">{{ panelCount }}</span>
              </button>
              <button
                v-if="inRepository"
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                @click="fromMenu(() => (changesOpen = true))"
              >
                <Icon name="git" class="h-4 w-4 text-zinc-400" />
                Alterações
                <span v-if="changesCount" class="ml-auto rounded-full bg-emerald-500/20 px-1.5 text-[10px] leading-4 text-emerald-300">{{ changesCount }}</span>
              </button>
              <button
                v-if="canCompact"
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800 disabled:text-zinc-500"
                :class="thread.session?.compactNext ? 'text-zinc-500' : 'text-amber-300'"
                :disabled="thread.session?.compactNext || compacting"
                @click="fromMenu(compactNow)"
              >
                <Icon name="compress" class="h-4 w-4" />
                {{ thread.session?.compactNext ? 'Compacta na próxima mensagem' : 'Compactar o contexto' }}
              </button>
              <button
                v-if="!embedded"
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                @click="fromMenu(toggleShare)"
              >
                <Icon name="share" class="h-4 w-4" :class="header.shared ? 'text-emerald-400' : 'text-zinc-400'" />
                {{ header.shared ? 'Parar de compartilhar' : 'Compartilhar por link' }}
              </button>
              <button
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                data-test="thread-menu-archive"
                @click="fromMenu(archiveConversation)"
              >
                <Icon name="archive" class="h-4 w-4 text-zinc-400" />
                Arquivar
              </button>
              <button
                role="menuitem"
                class="flex w-full items-center gap-2.5 border-t border-zinc-800 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800 hover:text-rose-300"
                @click="fromMenu(() => (confirming = true))"
              >
                <Icon name="trash" class="h-4 w-4 text-zinc-400" />
                Apagar histórico
              </button>
            </div>
          </div>
        </template>
      </div>
    </header>

    <div v-if="parentId" class="flex items-center gap-2 border-b border-violet-500/20 bg-violet-500/10 px-4 py-2 text-xs text-violet-200">
      Delegada por {{ parentAgent }}.
      <RouterLink :to="`/c/${parentId}`" class="ml-auto hover:text-white">← Voltar à conversa original</RouterLink>
    </div>
    <DelegationsPanel v-if="children.length" :items="children" :show-cost="projects.manages" />

    <div v-if="compactNotice && thread.session?.compactNext" class="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
      {{ compactNotice }}
      <button class="ml-auto hover:text-white" title="Fechar" @click="compactNotice = undefined"><Icon name="x" class="h-4 w-4" /></button>
    </div>
    <div v-if="actionError" class="flex items-center gap-2 border-b border-rose-500/20 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
      {{ actionError }}
      <button class="ml-auto hover:text-white" title="Fechar" @click="actionError = undefined"><Icon name="x" class="h-4 w-4" /></button>
    </div>

    <div v-if="shareUrl" class="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-xs text-emerald-200">
      Qualquer pessoa com o link pode ler esta conversa.
      <code class="truncate text-emerald-300">{{ shareUrl }}</code>
      <button class="btn btn-sm btn-ghost ml-auto" @click="copyShare">
        <Icon :name="copied ? 'check' : 'copy'" class="h-4 w-4" />
        {{ copied ? 'Copiado' : 'Copiar' }}
      </button>
    </div>

    <div
      ref="scroller"
      data-test="thread-scroller"
      @scroll.passive="onScroll"
      class="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgb(39_39_42/0.6)_1px,transparent_0)] [background-size:22px_22px] px-4 py-5"
    >
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        <p v-if="thread.loading" class="text-center text-sm text-zinc-500">Carregando conversa…</p>
        <p v-if="header" class="mx-auto rounded-full bg-zinc-900/80 px-3 py-1 text-xs text-zinc-400">Começou em {{ fullTime(header.createdAt) }}</p>
        <template v-for="(turn, index) in thread.turns" :key="`${turn.sessionId}-${turn.index}`">
          <p v-if="switchBefore(index)" class="mx-auto rounded-full border border-zinc-800 px-3 py-0.5 font-mono text-[11px] text-zinc-500">{{ switchBefore(index) }}</p>
          <TurnBubbles :turn="turn" :show-cost="projects.manages" />
        </template>
        <TurnBubbles v-if="thread.pending" :pending="thread.pending" :show-cost="projects.manages" />
        <p v-if="thread.error" class="mx-auto text-sm text-rose-300">{{ thread.error }}</p>
      </div>
      <!-- A pessoa subiu para ler e chegou coisa nova embaixo: o atalho de volta ao fim (e a rolagem volta a seguir). -->
      <div v-if="!pinned" class="pointer-events-none sticky bottom-2 flex justify-center">
        <button type="button" class="btn btn-sm btn-secondary pointer-events-auto shadow-lg shadow-black/40" data-test="thread-to-bottom" @click="toBottom">
          ↓ {{ unseen ? 'Novas mensagens' : 'Ir para o fim' }}
        </button>
      </div>
    </div>

    <ConfirmDialog
      :open="confirming"
      title="Apagar o histórico desta conversa?"
      :message="deleteError ?? 'Some da lista para todo mundo e não dá para desfazer.'"
      :busy="deleting"
      @confirm="remove"
      @cancel="confirming = false"
    />
    <!-- Celular: tela cheia; desktop: gaveta à direita, e a conversa ao lado segue usável (como as Alterações). -->
    <div v-if="panelOpen && header" class="fixed inset-0 z-40 bg-black/40 md:pointer-events-none md:bg-transparent" @click.self="panelOpen = false">
      <aside
        class="pointer-events-auto absolute top-0 right-0 flex h-full w-full flex-col border-l border-zinc-800 bg-zinc-950 p-4 shadow-2xl md:w-[460px]"
        aria-label="Painel da conversa"
      >
        <div class="min-h-0 flex-1 overflow-y-auto">
          <ConversationPanel :conversation-id="header.id" :refresh-key="panelRefresh" closable @close="panelOpen = false" @count="panelCount = $event" />
        </div>
      </aside>
    </div>
    <TodoPanel v-if="thread.todos.length" :items="thread.todos" />
    <WatchesPanel v-if="thread.watches.length" :items="thread.watches" :stop="thread.stopWatch" />
    <ChangesPanel v-if="changesOpen && thread.sessionId" :session-id="thread.sessionId" :refresh-key="changesRefresh" @close="changesOpen = false" @count="changesCount = $event" />
    <!-- ⚖️ Sessão encerrada (expirou, ou o gateway reiniciou) não tranca a conversa: ao enviar, o gateway a retoma com o histórico. -->
    <div v-if="resumable" class="flex items-center gap-3 border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
      <span class="min-w-0 truncate">A conversa foi encerrada. Ao enviar, ela continua de onde parou.</span>
      <button v-if="!embedded" class="btn btn-sm btn-ghost ml-auto" @click="continueFresh">
        <Icon name="refresh" class="h-3.5 w-3.5" />
        Começar uma nova
      </button>
    </div>
    <SessionTuner v-if="thread.liveSession && agent" :agent="agent" :mode="header?.mode" :fallback="{ provider: header?.provider, model: header?.model }" />
    <Composer
      :sending="thread.sending || thread.following"
      :disabled="thread.liveSession === undefined"
      :commands="commands"
      :queued="thread.queued"
      :restore="thread.leftover"
      @send="send"
      @stop="thread.stop"
      @restored="thread.leftover = undefined"
    />
  </section>
</template>
