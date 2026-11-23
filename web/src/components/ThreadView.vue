<script setup lang="ts">
  import { useListHidden } from '@/composables/useListHidden'
  import HostApprovals from './HostApprovals.vue'
  import MachineBadge from './MachineBadge.vue'
  import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { api } from '@/lib/api'
  import { useStickToBottom } from '@/composables/useStickToBottom'
  import { useDrawerWidth } from '@/composables/useDrawerWidth'
  import type { IConversation, TMode } from '@/lib/types'
  import { useRoute, useRouter } from 'vue-router'
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
  const route = useRoute()
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

  /** ⚖️ RENOMEAR: clicar no título abre o campo; Enter ou sair do campo grava, Esc desiste. Conversa só leitura não renomeia. */
  const canRename = computed(() => !!thread.sessionId && !thread.readOnly)
  const renaming = ref(false)
  const renameDraft = ref('')
  const renameError = ref<string>()
  const renameInput = ref<HTMLInputElement>()
  async function startRename(): Promise<void> {
    renameDraft.value = header.value?.title ?? ''
    renameError.value = undefined
    renaming.value = true
    await nextTick()
    renameInput.value?.select()
  }
  async function saveTitle(): Promise<void> {
    if (!renaming.value) return
    renaming.value = false
    const id = thread.sessionId
    const title = renameDraft.value.trim()
    if (!id || !title || title === header.value?.title) return
    try {
      await api(`/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } })
      if (thread.header?.id === id) thread.header = { ...thread.header, title }
    } catch (failure) {
      renameError.value = failure instanceof Error ? failure.message : 'Não foi possível renomear.'
    }
  }

  /** As alterações (o painel tipo IDE): só numa conversa aberta num repositório. O diff (e o destaque) só carrega ao abrir. */
  const ChangesPanel = defineAsyncComponent(() => import('./ChangesPanel.vue'))
  const ConversationPanel = defineAsyncComponent(() => import('./ConversationPanel.vue'))
  /** 👁️ O navegador da conversa ao vivo: aparece (e abre, no desktop) quando o agente usa uma ferramenta de navegador. */
  const { hidden: listHidden, toggle: toggleList } = useListHidden()
  const LiveBrowser = defineAsyncComponent(() => import('./LiveBrowser.vue'))
  /**
   * 🧭 A COLUNA LATERAL da conversa é UMA: navegador, arquivos, alterações, board ou terminal, um de cada vez, com a
   * barra de ícones em cima para trocar num clique. Cada `xxxOpen` é só uma vista dela.
   */
  type TSidePane = 'changes' | 'files' | 'board' | 'browser' | 'terminal'
  const sidePane = ref<TSidePane>()
  const sideFlag = (pane: TSidePane) =>
    computed({
      get: () => sidePane.value === pane,
      set: (open: boolean) => {
        if (open) sidePane.value = pane
        else if (sidePane.value === pane) sidePane.value = undefined
      },
    })
  /** O editor e o terminal ficam montados depois de abertos: trocar de recurso não perde abas nem o que saiu. */
  const keepMounted = ref(new Set<TSidePane>())
  watch(sidePane, (pane) => {
    if (pane === 'files' || pane === 'terminal') keepMounted.value = new Set([...keepMounted.value, pane])
  })
  const browserOpen = sideFlag('browser')
  const browserSeen = ref(false)
  const browserDrawer = useDrawerWidth('gw.browser.width', 640)
  watch(
    () => header.value?.id,
    () => {
      sidePane.value = undefined
      keepMounted.value = new Set()
      browserSeen.value = false
    },
  )
  watch(
    () => thread.browserVersion,
    () => {
      if (browserSeen.value) return
      browserSeen.value = true
      if (window.matchMedia?.('(min-width: 768px)').matches) openBrowser()
    },
  )
  /** 🎯 O elemento escolhido com a seta do navegador vai para o fim da caixa de mensagem. */
  const composerAppend = ref<string>()
  function pickElement(element: { tag: string; selector: string; text?: string; html: string; url?: string }) {
    const fence = '```'
    composerAppend.value = [
      `Elemento no navegador${element.url ? ` (${element.url})` : ''}:`,
      `- seletor: \`${element.selector}\``,
      ...(element.text ? [`- texto: "${element.text}"`] : []),
      `${fence}html`,
      element.html,
      fence,
    ].join('\n')
  }
  function openBrowser() {
    panelOpen.value = false
    filesOpen.value = false
    changesOpen.value = false
    terminalOpen.value = false
    browserOpen.value = true
  }
  /** 📁 Os arquivos do repositório da conversa (Monaco): a mesma coluna ao lado, no lugar do navegador. */
  const RepositoryFiles = defineAsyncComponent(() => import('./RepositoryFiles.vue'))
  const filesOpen = sideFlag('files')
  function openFiles() {
    panelOpen.value = false
    browserOpen.value = false
    changesOpen.value = false
    terminalOpen.value = false
    filesOpen.value = true
  }
  /**
   * ⌨️ Os atalhos da coluna lateral, no padrão do VS Code: ⌘⇧B navegador, ⌘⇧E arquivos, ⌃⇧G alterações. De novo, fecha.
   * Na captura: valem também dentro do editor e da caixa de mensagem (nenhum deles usa essas teclas).
   */
  function onShortcut(event: KeyboardEvent) {
    if (!props.embedded && event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Backquote' && terminalAvailable.value) {
      event.preventDefault()
      event.stopPropagation()
      return terminalOpen.value ? void (terminalOpen.value = false) : openTerminal()
    }
    if (props.embedded || !event.shiftKey || event.altKey || !header.value) return
    const key = event.key.toLowerCase()
    const meta = event.metaKey && !event.ctrlKey
    const ctrl = event.ctrlKey && !event.metaKey
    let action: (() => void) | undefined
    if (meta && key === 'b' && thread.sessionId) action = () => (browserOpen.value ? (browserOpen.value = false) : openBrowser())
    else if (meta && key === 'e' && inRepository.value && thread.sessionId) action = () => (filesOpen.value ? (filesOpen.value = false) : openFiles())
    else if (ctrl && key === 'g' && inRepository.value) action = () => (changesOpen.value ? (changesOpen.value = false) : openChanges())
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    action()
  }
  onMounted(() => window.addEventListener('keydown', onShortcut, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', onShortcut, true))

  /** A barra da coluna: um ícone por recurso (em ordem alfabética, como no menu), o ativo aceso. */
  const sideItems = computed(() =>
    [
      { id: 'changes' as const, label: 'Alterações', icon: 'git' as const, keys: '⌃⇧G', show: inRepository.value },
      { id: 'files' as const, label: 'Arquivos', icon: 'folder' as const, keys: '⌘⇧E', show: inRepository.value && !!thread.sessionId },
      { id: 'board' as const, label: 'Board', icon: 'panel' as const, keys: '', show: !!header.value },
      { id: 'browser' as const, label: 'Navegador', icon: 'globe' as const, keys: '⌘⇧B', show: !!thread.sessionId },
      { id: 'terminal' as const, label: 'Terminal', icon: 'slash' as const, keys: '⌃`', show: terminalAvailable.value },
    ].filter((item) => item.show),
  )
  const sideLabel = computed(() => sideItems.value.find((item) => item.id === sidePane.value)?.label ?? '')

  /** As Alterações (o diff do que o agente mudou): a mesma coluna, a mesma largura. */
  function openChanges() {
    panelOpen.value = false
    browserOpen.value = false
    filesOpen.value = false
    terminalOpen.value = false
    changesOpen.value = true
  }
  /** ⌨️ O terminal local (o shell do seu computador): só existe no app do Mac, para o admin; a mesma coluna. */
  const LocalTerminal = defineAsyncComponent(() => import('./LocalTerminal.vue'))
  const terminalOpen = sideFlag('terminal')
  const terminalAvailable = ref(false)
  onMounted(() => {
    if (props.embedded) return
    void api<{ available: boolean }>('/terminal')
      .then((status) => (terminalAvailable.value = status.available))
      .catch(() => undefined)
  })
  function openTerminal() {
    panelOpen.value = false
    browserOpen.value = false
    filesOpen.value = false
    changesOpen.value = false
    terminalOpen.value = true
  }
  /**
   * ⚖️ As leituras SECUNDÁRIAS de uma conversa (Board, mudanças, filhas) esperam o que a desenha (sessão e turnos, ver
   * `thread.loading` e `thread.revalidating`) e saem no tempo ocioso: a troca de conversa não compete por conexão com elas.
   * Pedir de novo com o mesmo nome troca o pedido anterior.
   */
  const deferred = new Map<string, () => void>()
  const drawing = () => thread.loading || thread.revalidating
  function afterPrimary(name: string, run: () => void): void {
    deferred.get(name)?.()
    let stop: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: number | undefined
    const cancel = () => {
      stop?.()
      clearTimeout(timer)
      if (idle !== undefined && typeof cancelIdleCallback === 'function') cancelIdleCallback(idle)
      deferred.delete(name)
    }
    const go = () => {
      const fire = () => {
        deferred.delete(name)
        run()
      }
      if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(fire, { timeout: 500 })
      else timer = setTimeout(fire, 0)
    }
    deferred.set(name, cancel)
    if (!drawing()) go()
    else
      stop = watch(drawing, (busy) => {
        if (busy) return
        stop?.()
        go()
      })
  }
  onBeforeUnmount(() => [...deferred.values()].forEach((cancel) => cancel()))
  /** O Board da conversa: o selo do ícone (itens em aberto) vale com o painel fechado; o painel relê quando abre, quando o turno acaba e quando o agente mexe nele. */
  const panelOpen = sideFlag('board')
  // ⚖️ Guardados com a conversa (`thread.aux`): ao revisitar, o selo já está lá e a releitura só o confirma.
  const panelCount = computed({ get: () => thread.aux.panelCount, set: (value) => (thread.aux.panelCount = value) })
  /** Planos esperando a sua aprovação: o ponto amarelo no ícone do Board. */
  const plansWaiting = computed({ get: () => thread.aux.plansWaiting ?? 0, set: (value) => (thread.aux.plansWaiting = value) })
  const panelRefresh = ref(0)
  async function loadPanelCount() {
    const id = header.value?.id
    if (!id) return void (panelCount.value = undefined)
    const result = await api<IConversationPanel>(`/conversations/${encodeURIComponent(id)}/panel`).catch(() => undefined)
    if (id !== header.value?.id) return
    panelCount.value = result ? openCount(result) : undefined
    plansWaiting.value = (result?.plans ?? []).filter((plan) => plan.status === 'review').length
  }
  watch(
    () => header.value?.id,
    () => afterPrimary('panel', () => void loadPanelCount()),
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
  const changesOpen = sideFlag('changes')
  const changesCount = computed({ get: () => thread.aux.changesCount, set: (value) => (thread.aux.changesCount = value) })
  const changesRefresh = ref(0)
  const inRepository = computed(() => typeof header.value?.metadata?.repository === 'string' && !!thread.sessionId)
  async function loadChangesCount() {
    if (!inRepository.value || !thread.sessionId) return void (changesCount.value = undefined)
    const result = await api<{ files: unknown[] }>(`/sessions/${encodeURIComponent(thread.sessionId)}/changes`, { query: { scope: 'conversation' } }).catch(() => undefined)
    changesCount.value = result?.files.length
  }
  watch(inRepository, () => afterPrimary('changes', () => void loadChangesCount()), { immediate: true })
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
  /** O projeto DA CONVERSA (o do cabeçalho); conversa nova, o atual. */
  const conversationProject = computed(() => (typeof header.value?.metadata?.project === 'string' ? header.value.metadata.project : (projects.current ?? undefined)))
  const commands = useAgentCommands(
    computed(() => agent.value?.id ?? header.value?.agentId ?? thread.agentId),
    // Os documentos do `/` são os do projeto DA CONVERSA (o do cabeçalho); conversa nova, o projeto atual.
    computed(() => (typeof header.value?.metadata?.project === 'string' ? header.value.metadata.project : (projects.current ?? undefined))),
  )
  /** A sessão não está viva, mas a conversa volta ao enviar (o gateway a retoma do histórico gravado). */
  // Com um turno rodando a conversa não está encerrada, mesmo que o servidor ainda não a tenha marcado viva de novo.
  const resumable = computed(() => thread.liveSession === false && !thread.pending && !thread.readOnly)

  /** De quem esta conversa é filha (delegada por outro agente) e as filhas que ela abriu. */
  const parentId = computed(() => (typeof header.value?.metadata?.delegatedBy === 'string' ? header.value.metadata.delegatedBy : undefined))
  const parentAgent = computed(() => {
    const from = header.value?.metadata?.delegatedFrom
    return typeof from === 'string' ? (agents.byId.get(from)?.name ?? from) : 'outro agente'
  })
  const children = computed({ get: () => thread.aux.children ?? [], set: (value) => (thread.aux.children = value) })
  // Relida também quando uma conversa começa ou para de rodar: a filha contactada no meio do turno aparece e sobe na hora.
  // ⚖️ Os gatilhos que chegam juntos (abriu a conversa, os turnos carregaram, o cabeçalho veio) viram UMA leitura: eram três
  // a cada troca de conversa.
  let childrenTimer: ReturnType<typeof setTimeout> | undefined
  async function loadChildren(): Promise<void> {
    const id = header.value?.id
    if (!id) return void (children.value = [])
    const page = await api<{ sessions: IConversation[] }>('/conversations', { query: { delegatedBy: id, limit: 50 } }).catch(() => ({ sessions: [] }))
    if (id === header.value?.id) children.value = page.sessions
  }
  watch(
    () => [header.value?.id, thread.turns.length, conversations.running] as const,
    ([id], before) => {
      clearTimeout(childrenTimer)
      // Trocou de conversa: as filhas vêm com a conversa (as guardadas, ou nenhuma), e a leitura nova espera a conversa aparecer.
      if (!id) return
      childrenTimer = setTimeout(() => afterPrimary('children', () => void loadChildren()), 50)
    },
    { immediate: true },
  )
  onBeforeUnmount(() => clearTimeout(childrenTimer))
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
  const content = ref<HTMLElement>()
  const { pinned, unseen, onScroll, toBottom, grew } = useStickToBottom(scroller, content)
  // O que cresce EMBAIXO (turno novo, a resposta chegando). O último índice, não o tamanho: os anteriores entram em cima.
  watch(
    () => [thread.turns.at(-1)?.index, thread.pending?.text.length, thread.pending?.tools.length],
    () => grew(),
  )

  /** Perto do topo, a conversa traz os turnos anteriores (ver `TURN_PAGE`). */
  const OLDER_AT_PX = 300

  /**
   * ⚖️ OS ANTERIORES ENTRAM EM CIMA SEM A TELA PULAR: guarda a distância até o fim, traz a página e volta a ela — o turno que
   * estava à vista fica no lugar. Enquanto o conteúdo não enche a tela (não há o que rolar), segue trazendo.
   */
  async function loadOlder() {
    const element = scroller.value
    if (!element || !thread.hasOlder || thread.loadingOlder) return
    const fromBottom = element.scrollHeight - element.scrollTop
    if (!(await thread.loadOlder())) return
    await nextTick()
    element.scrollTop = element.scrollHeight - fromBottom
    if (element.scrollHeight <= element.clientHeight + OLDER_AT_PX) void loadOlder()
  }

  function scrolled() {
    onScroll()
    if (scroller.value && scroller.value.scrollTop < OLDER_AT_PX) void loadOlder()
  }

  /**
   * 💬 `?turn=N` (o link da tela Mensagens): abre a conversa NAQUELE turno — traz os anteriores até ele estar carregado e
   * rola até ele, com um destaque rápido. Turno que não existe mais: fica no fim, como sempre.
   */
  async function goToTurn(target: number) {
    for (let page = 0; page < 40 && !thread.turns.some((turn) => turn.index <= target) && thread.hasOlder; page++) if (!(await thread.loadOlder())) break
    await nextTick()
    const element = scroller.value?.querySelector<HTMLElement>(`[data-turn="${target}"]`)
    if (!element) return
    pinned.value = false
    element.scrollIntoView({ block: 'start' })
    element.classList.add('turn-focus')
    setTimeout(() => element.classList.remove('turn-focus'), 2500)
  }
  watch(
    () => [thread.loading, route.query.turn] as const,
    async ([busy, turn]) => {
      const target = typeof turn === 'string' && /^\d+$/.test(turn) ? Number(turn) : undefined
      if (busy || target === undefined) return
      await goToTurn(target)
    },
    { immediate: true },
  )

  // Abriu (ou releu) com poucos turnos à vista: traz os anteriores até haver o que rolar.
  watch(
    () => thread.loading,
    async (busy) => {
      if (busy) return
      await nextTick()
      const element = scroller.value
      if (element && element.scrollHeight <= element.clientHeight + OLDER_AT_PX) void loadOlder()
    },
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
   * ⚖️ As ações do cabeçalho (board, alterações, compactar, compartilhar, arquivar, apagar) moram num menu "⋯", no estilo
   * do menu da conta, no celular e no desktop: o título ganha o espaço. O medidor de contexto continua à vista (e abre o consumo).
   */
  const { open: menuOpen, root: menuRoot } = usePopover()
  function fromMenu(action: () => unknown) {
    menuOpen.value = false
    void action()
  }
  /** Copia o id da conversa; o item diz "Copiado" por um instante e o menu fecha. */
  const idCopied = ref(false)
  async function copySessionId() {
    const id = header.value?.id ?? thread.sessionId
    if (!id) return
    try {
      await copyText(id)
      idCopied.value = true
      setTimeout(() => {
        idCopied.value = false
        menuOpen.value = false
      }, 900)
    } catch {
      menuOpen.value = false
    }
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
  <!-- 👁️ O navegador ao vivo, no desktop, é uma coluna AO LADO da conversa (as duas dividem a largura); no celular, tela cheia. -->
  <div class="flex h-full min-w-0">
    <section class="flex h-full min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-3 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
        <button
          v-if="!embedded"
          type="button"
          class="hidden h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:grid"
          :title="listHidden ? 'Mostrar as conversas' : 'Esconder as conversas'"
          data-test="toggle-list"
          @click="toggleList"
        >
          <Icon name="panel" class="h-5 w-5 -scale-x-100" />
        </button>
        <RouterLink v-if="!embedded" to="/" class="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 lg:hidden" title="Voltar">
          <Icon name="back" class="h-5 w-5" />
        </RouterLink>
        <AgentAvatar :name="agentName ?? '?'" :provider="currentProvider || 'claude'" size="sm" />
        <div class="min-w-0">
          <input
            v-if="renaming"
            ref="renameInput"
            v-model="renameDraft"
            class="input h-7 w-full py-0 font-medium"
            maxlength="120"
            aria-label="Título da conversa"
            data-test="thread-title-input"
            @keydown.enter.prevent="saveTitle"
            @keydown.esc.prevent="renaming = false"
            @blur="saveTitle"
          />
          <button
            v-else-if="canRename"
            type="button"
            class="block max-w-full cursor-text truncate text-left font-medium hover:text-emerald-300"
            title="Renomear"
            data-test="thread-title"
            @click="startRename"
          >
            {{ header?.title || agentName || 'Conversa' }}
          </button>
          <div v-else class="truncate font-medium">{{ header?.title || agentName || 'Conversa' }}</div>
          <div v-if="renameError" class="truncate text-xs text-rose-300" data-test="thread-title-error">{{ renameError }}</div>
          <div class="truncate text-xs text-zinc-400">
            <MachineBadge :project-id="conversationProject" :agent-id="agent?.id ?? header?.agentId ?? thread.agentId" />
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
          <!-- ⚖️ À vista ficam só o medidor de contexto (que abre o consumo) e o menu "⋯" com as ações, no desktop e no celular:
             o título ganha o espaço. -->
          <TokensMenu
            v-if="header?.usage.totalTokens"
            :usage="header.usage"
            :cost-usd="projects.manages ? header.costUsd : undefined"
            :cost-is-floor="header.costIsFloor"
            :turns="header.turns"
            :context="context"
          >
            <span v-if="context" class="grid h-8 w-8 place-items-center" data-test="context-meter">
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
            </span>
          </TokensMenu>
          <div
            v-else-if="context"
            class="grid h-8 w-8 place-items-center"
            :title="`Contexto da conversa: ${context.label.replace(' / ', ' de ').replace(' usados', '')} tokens`"
            data-test="context-meter"
          >
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
          <template v-if="header">
            <button
              v-if="browserSeen && thread.sessionId"
              type="button"
              class="relative grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800"
              :class="browserOpen ? 'text-emerald-300' : 'text-zinc-400'"
              title="Navegador ao vivo"
              data-test="browser-toggle"
              @click="browserOpen ? (browserOpen = false) : openBrowser()"
            >
              <Icon name="globe" class="h-5 w-5" />
              <span class="absolute top-1.5 right-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            </button>
            <div ref="menuRoot" class="relative">
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
                class="absolute top-full right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40"
                data-test="thread-menu-items"
              >
                <button
                  v-if="inRepository"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  @click="fromMenu(openChanges)"
                >
                  <Icon name="git" class="h-4 w-4 text-zinc-400" />
                  Alterações
                  <span v-if="changesCount" class="ml-auto rounded-full bg-emerald-500/20 px-1.5 text-[10px] leading-4 text-emerald-300">{{ changesCount }}</span>
                  <kbd class="pl-2 font-sans text-[10px] text-zinc-500" :class="{ 'ml-auto': !changesCount }">⌃⇧G</kbd>
                </button>
                <button
                  v-if="inRepository && thread.sessionId"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  data-test="files-item"
                  @click="fromMenu(openFiles)"
                >
                  <Icon name="folder" class="h-4 w-4 text-zinc-400" />
                  Arquivos
                  <kbd class="ml-auto pl-2 font-sans text-[10px] text-zinc-500">⌘⇧E</kbd>
                </button>
                <button
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  @click="fromMenu(() => ((panelOpen = !panelOpen), (browserOpen = false), (filesOpen = false), (changesOpen = false), (terminalOpen = false)))"
                >
                  <Icon name="panel" class="h-4 w-4 text-zinc-400" />
                  Board
                  <span v-if="panelCount" class="ml-auto rounded-full bg-emerald-500/20 px-1.5 text-[10px] leading-4 text-emerald-300">{{ panelCount }}</span>
                </button>
                <button
                  v-if="thread.sessionId"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  data-test="browser-item"
                  @click="fromMenu(openBrowser)"
                >
                  <Icon name="globe" class="h-4 w-4 text-zinc-400" />
                  Navegador
                  <kbd class="ml-auto pl-2 font-sans text-[10px] text-zinc-500">⌘⇧B</kbd>
                  <span v-if="browserSeen" class="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </button>
                <button
                  v-if="terminalAvailable"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  data-test="terminal-item"
                  @click="fromMenu(openTerminal)"
                >
                  <Icon name="slash" class="h-4 w-4 text-zinc-400" />
                  Terminal
                  <kbd class="ml-auto pl-2 font-sans text-[10px] text-zinc-500">⌃`</kbd>
                </button>
                <div role="separator" class="my-1 border-t border-zinc-800" />
                <button
                  v-if="canCompact"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800 disabled:text-zinc-500"
                  :class="thread.session?.compactNext ? 'text-zinc-500' : 'text-amber-300'"
                  :disabled="thread.session?.compactNext || compacting"
                  :title="thread.session?.compactNext ? 'Compacta na próxima mensagem' : 'Compactar o contexto'"
                  @click="fromMenu(compactNow)"
                >
                  <Icon name="compress" class="h-4 w-4" />
                  {{ thread.session?.compactNext ? 'Agendada' : 'Compactar' }}
                </button>
                <button
                  v-if="!embedded"
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  @click="fromMenu(toggleShare)"
                >
                  <Icon name="share" class="h-4 w-4" :class="header.shared ? 'text-emerald-400' : 'text-zinc-400'" />
                  {{ header.shared ? 'Descompartilhar' : 'Compartilhar' }}
                </button>
                <button
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800"
                  title="Copiar o id da conversa"
                  data-test="thread-menu-copy-id"
                  @click="copySessionId"
                >
                  <Icon name="copy" class="h-4 w-4" :class="idCopied ? 'text-emerald-400' : 'text-zinc-400'" />
                  {{ idCopied ? 'Copiado' : 'Copiar ID' }}
                </button>
                <div role="separator" class="my-1 border-t border-zinc-800" />
                <button
                  role="menuitem"
                  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800 hover:text-rose-300"
                  @click="fromMenu(() => (confirming = true))"
                >
                  <Icon name="trash" class="h-4 w-4 text-zinc-400" />
                  Apagar
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
      <!-- Logo abaixo das delegações: o que a conversa espera fica no alto, junto do que ela pediu a outros. -->
      <WatchesPanel v-if="thread.watches.length" :items="thread.watches" :stop="thread.stopWatch" />

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
        @scroll.passive="scrolled"
        class="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_1px_1px,rgb(39_39_42/0.6)_1px,transparent_0)] [background-size:22px_22px] px-4 py-5"
      >
        <div ref="content" class="mx-auto flex max-w-3xl flex-col gap-5">
          <p v-if="thread.loading" class="text-center text-sm text-zinc-500">Carregando conversa…</p>
          <!-- Os turnos anteriores vêm ao rolar até aqui; o botão é o caminho para quem não rola (teclado, leitor de tela). -->
          <p v-if="thread.hasOlder" class="text-center text-xs text-zinc-500" data-test="thread-older">
            <span v-if="thread.loadingOlder">Carregando mensagens anteriores…</span>
            <button v-else type="button" class="btn btn-sm btn-ghost" @click="loadOlder">Ver mensagens anteriores</button>
          </p>
          <p v-else-if="header" class="mx-auto rounded-full bg-zinc-900/80 px-3 py-1 text-xs text-zinc-400">Começou em {{ fullTime(header.createdAt) }}</p>
          <template v-for="(turn, index) in thread.turns" :key="`${turn.sessionId}-${turn.index}`">
            <p v-if="switchBefore(index)" class="mx-auto rounded-full border border-zinc-800 px-3 py-0.5 font-mono text-[11px] text-zinc-500">{{ switchBefore(index) }}</p>
            <div :data-turn="turn.index" class="flex flex-col gap-5 rounded-2xl transition-colors"><TurnBubbles :turn="turn" :show-cost="projects.manages" /></div>
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
      <TodoPanel v-if="thread.todos.length" :items="thread.todos" />
      <!-- ⚖️ Sessão encerrada (expirou, ou o gateway reiniciou) não tranca a conversa: ao enviar, o gateway a retoma com o histórico. -->
      <div v-if="resumable" class="flex items-center gap-3 border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
        <span class="min-w-0 truncate">A conversa foi encerrada. Ao enviar, ela continua de onde parou.</span>
        <button v-if="!embedded" class="btn btn-sm btn-ghost ml-auto" @click="continueFresh">
          <Icon name="refresh" class="h-3.5 w-3.5" />
          Começar uma nova
        </button>
      </div>
      <!-- ⚖️ Conversa de outra pessoa (o admin abriu): só leitura. Mandar mensagem nela o gateway recusa. -->
      <p v-if="thread.readOnly" class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3 text-center text-xs text-zinc-400" data-test="thread-read-only">
        Conversa de {{ owner?.email ?? owner?.id ?? 'outra pessoa' }} — só leitura.
      </p>
      <HostApprovals v-if="!thread.readOnly" :session-id="thread.loading || thread.revalidating ? undefined : thread.sessionId" :running="!!thread.pending || !!thread.following" />
      <SessionTuner v-if="thread.liveSession && agent && !thread.readOnly" :agent="agent" :mode="header?.mode" :fallback="{ provider: header?.provider, model: header?.model }" />
      <Composer
        v-if="!thread.readOnly"
        :sending="thread.sending || thread.following"
        :disabled="thread.liveSession === undefined"
        :commands="commands"
        :queued="thread.queued"
        :restore="thread.leftover"
        :append="composerAppend"
        @appended="composerAppend = undefined"
        :draft-key="thread.sessionId"
        :suggestion="thread.nextSuggestion"
        @send="send"
        @stop="thread.stop"
        @restored="thread.leftover = undefined"
      />
    </section>
    <aside
      v-if="sidePane"
      class="fixed inset-0 z-40 flex flex-col bg-zinc-950 pt-[env(safe-area-inset-top)] pb-[var(--safe-bottom)] md:relative md:pt-0 md:pb-0 md:inset-auto md:z-auto md:w-[var(--side-width)] md:max-w-[calc(100%-22rem)] md:shrink-0 md:border-l md:border-zinc-800"
      :style="{ '--side-width': `${browserDrawer.width.value}px` }"
      :aria-label="sideLabel"
      data-test="side-pane"
    >
      <div
        class="absolute top-0 left-0 z-10 hidden h-full w-1.5 cursor-col-resize hover:bg-emerald-500/30 md:block"
        @pointerdown="browserDrawer.startDrag"
        @pointermove="browserDrawer.onDrag"
        @pointerup="browserDrawer.stopDrag"
      />
      <div class="side-bar flex h-9 shrink-0 items-center gap-1 pr-1 pl-3" data-test="side-bar">
        <span class="text-xs font-medium tracking-wide text-[#f8f8f2] uppercase">{{ sideLabel }}</span>
        <div class="ml-auto flex items-center">
          <button
            v-for="item in sideItems"
            :key="item.id"
            type="button"
            class="side-icon relative grid h-8 w-8 place-items-center rounded-md"
            :class="{ on: sidePane === item.id }"
            :title="item.id === 'board' && plansWaiting ? `Board — ${plansWaiting} plano(s) esperando a sua aprovação` : item.keys ? `${item.label} (${item.keys})` : item.label"
            :data-test="`side-${item.id}`"
            @click="sidePane = sidePane === item.id ? undefined : item.id"
          >
            <Icon :name="item.icon" class="h-4 w-4" />
            <span
              v-if="item.id === 'board' && plansWaiting"
              class="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-400"
              :title="`${plansWaiting} plano(s) esperando a sua aprovação`"
              data-test="side-board-waiting"
            />
          </button>
          <span class="mx-1 h-4 w-px bg-[#3b3a32]" />
          <button type="button" class="side-icon grid h-8 w-8 place-items-center rounded-md" title="Fechar" data-test="side-close" @click="sidePane = undefined">
            <Icon name="x" class="h-4 w-4" />
          </button>
        </div>
      </div>
      <div class="relative min-h-0 flex-1">
        <LiveBrowser v-if="sidePane === 'browser' && thread.sessionId" :session-id="thread.sessionId" :interactive="!thread.readOnly" @pick="pickElement" />
        <ChangesPanel
          v-else-if="sidePane === 'changes' && thread.sessionId"
          embedded
          :session-id="thread.sessionId"
          :refresh-key="changesRefresh"
          @close="changesOpen = false"
          @count="changesCount = $event"
        />
        <div v-else-if="sidePane === 'board' && header" class="h-full overflow-y-auto p-4" data-test="board-pane">
          <!-- O Board ocupa a largura da coluna: um cartão por linha. -->
          <div>
            <ConversationPanel :conversation-id="header.id" :refresh-key="panelRefresh" @count="panelCount = $event" @waiting="plansWaiting = $event" />
          </div>
        </div>
        <RepositoryFiles
          v-if="keepMounted.has('files') && thread.sessionId"
          v-show="sidePane === 'files'"
          :session-id="thread.sessionId"
          :running="!!thread.pending || !!thread.following"
          :read-only="thread.readOnly"
          class="absolute inset-0"
          @close="filesOpen = false"
        />
        <LocalTerminal
          v-if="keepMounted.has('terminal')"
          v-show="sidePane === 'terminal'"
          :conversation="inRepository ? thread.sessionId : undefined"
          class="absolute inset-0"
          @close="terminalOpen = false"
        />
      </div>
    </aside>
  </div>
</template>

<style scoped>
  .side-bar {
    background: #1e1f1c;
    border-bottom: 1px solid #3b3a32;
  }
  .side-icon {
    color: #75715e;
  }
  .side-icon:hover {
    background: #3e3d32;
    color: #f8f8f2;
  }
  .side-icon.on {
    background: #49483e;
    color: #a6e22e;
  }
  .turn-focus {
    background: rgb(16 185 129 / 0.08);
    box-shadow: 0 0 0 1px rgb(16 185 129 / 0.35);
  }
</style>
