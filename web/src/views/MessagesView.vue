<script setup lang="ts">
  import { computed, nextTick, onMounted, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import AgentAvatar from '@/components/AgentAvatar.vue'
  import Icon from '@/components/Icon.vue'
  import MasterDetail from '@/components/MasterDetail.vue'
  import MessageThreadRow from '@/components/MessageThreadRow.vue'
  import { api } from '@/lib/api'
  import { disablePush, enablePush, pushState, type TPushState } from '@/lib/push'
  import { shortTime, fullTime } from '@/lib/format'
  import { renderMarkdown } from '@/lib/markdown'
  import type { ITurn } from '@/lib/types'
  import { readDraft, writeDraft } from '@/lib/draftStorage'
  import { usePopover } from '@/lib/popover'
  import { useAttachments } from '@/composables/useAttachments'
  import { useAgentsStore } from '@/stores/agents'
  import { useSpeechStore } from '@/stores/speech'
  import { isResolved, useMessagesStore, type IOutgoingReply, type IPersonMessage, type IPersonThread } from '@/stores/messages'

  /**
   * 💬 MENSAGENS: o que os agentes escreveram para a pessoa (`notify`), num fio por conversa — como um app de mensagens. A
   * resposta entra na conversa de origem como mensagem dela, e o que o agente responde volta para cá. Acima do fio, o
   * CONTEXTO: as trocas da conversa até o turno em que o agente escreveu (com "Ler mais acima") e o link que abre a conversa
   * exatamente nele.
   */
  const props = defineProps<{ id?: string }>()
  const route = useRoute()
  const router = useRouter()
  const messages = useMessagesStore()
  const agents = useAgentsStore()
  const speech = useSpeechStore()

  const error = ref<string>()
  const draft = ref('')
  const search = ref('')

  // 📱 O aviso no aparelho (Web Push): ligado por um toque, aparelho a aparelho.
  const push = ref<TPushState>()
  const pushBusy = ref(false)
  const pushError = ref<string>()
  async function togglePush(on: boolean) {
    pushBusy.value = true
    pushError.value = undefined
    try {
      push.value = on ? await enablePush() : await disablePush()
    } catch (failure) {
      pushError.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      pushBusy.value = false
    }
  }

  const LEVEL: Record<string, string> = { info: '', attention: 'Precisa de você', urgent: 'Urgente' }

  // 📌 Cada pedido (attention/urgent) tem o seu estado e a sua resposta.
  const STATUS = {
    pending: { label: 'Pendente', css: 'bg-amber-500/20 text-amber-300' },
    answered: { label: 'Respondido', css: 'bg-emerald-500/20 text-emerald-300' },
    resolved: { label: 'Resolvido', css: 'bg-zinc-700/60 text-zinc-300' },
  } as const
  const statusLabel = (message: IPersonMessage) => (message.status === 'answered' && message.answeredAt ? `Respondido ${shortTime(message.answeredAt)}` : STATUS[message.status ?? 'pending'].label)
  /** O nome do pedido: o título ou o começo do texto. */
  const requestLabel = (message: IPersonMessage) => (message.title || message.body.replace(/\s+/g, ' ').trim()).slice(0, 60)
  const replyTarget = ref<string>()
  const composer = ref<HTMLTextAreaElement>()

  onMounted(() => {
    void pushState()
      .then((state) => (push.value = state))
      .catch(() => (push.value = 'unsupported'))
    void messages.load().catch((failure) => (error.value = failure instanceof Error ? failure.message : String(failure)))
    void agents.ensure().catch(() => undefined)
  })

  const agentName = (id: string) => agents.byId.get(id)?.name ?? id
  const agentProvider = (id: string) => agents.byId.get(id)?.providers?.[0]?.id ?? ''
  const shown = computed(() => {
    const term = search.value.trim().toLowerCase()
    return term ? messages.threads.filter((thread) => `${agentName(thread.agentId)} ${thread.title ?? ''} ${thread.last.body}`.toLowerCase().includes(term)) : messages.threads
  })
  /** O item aberto (`id` da rota): um pedido ou os avisos de uma conversa. */
  const current = computed<IPersonThread | undefined>(() => messages.threads.find((thread) => thread.id === props.id))
  /** A conversa de origem do item aberto (o contexto e o link). */
  const conversationId = computed(() => current.value?.conversationId ?? (messages.open?.key === props.id ? messages.open?.conversationId : undefined))
  /** 🔌 O item é de um projeto conectado: a conversa mora na origem (sem o contexto daqui; o link abre lá). */
  const origin = computed(() => current.value?.origin)
  /** O endereço da conversa na origem (o endereço da conexão pode vir com `/v1`). */
  const originLink = computed(() => {
    if (!origin.value || !conversationId.value) return undefined
    const base = origin.value.url.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
    return `${base}/c/${encodeURIComponent(conversationId.value)}${turn.value === undefined ? '' : `?turn=${turn.value}`}`
  })
  const fio = computed(() => (messages.open?.key === props.id ? (messages.open?.messages ?? []) : []))
  // O link antigo (o app do Mac, um aviso de antes) traz o id da CONVERSA: sem item de avisos dela, vai para o pedido mais
  // recente dela.
  watch(
    () => [props.id, messages.loaded, messages.threads] as const,
    ([id, loaded, threads]) => {
      if (!id || !loaded || threads.some((thread) => thread.id === id)) return
      const latest = threads.find((thread) => thread.conversationId === id)
      if (latest) void router.replace(`/messages/${encodeURIComponent(latest.id)}`)
    },
    { immediate: true },
  )
  /** O turno do contexto: o da última mensagem do agente (é ali que ele precisou da pessoa). */
  const targetMessage = computed(() => fio.value.find((message) => message.id === replyTarget.value))
  const shownFio = fio
  const requestOf = (message: IPersonMessage) => (message.replyTo ? fio.value.find((candidate) => candidate.id === message.replyTo) : undefined)

  function replyTo(message: IPersonMessage) {
    replyTarget.value = message.id
    void nextTick(() => composer.value?.focus())
  }
  async function setStatus(message: IPersonMessage, status: 'resolved' | 'pending') {
    if (!props.id) return
    error.value = undefined
    try {
      await messages.setStatus(props.id, message.id, status)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    }
  }
  function goToRequest(id: string) {
    document.querySelector(`[data-message-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  const turn = computed(() => [...fio.value].reverse().find((message) => message.from === 'agent' && message.turn !== undefined)?.turn)

  // O CONTEXTO: os turnos até aquele em que o agente escreveu; "Ler mais acima" traz mais.
  const context = ref<ITurn[]>()
  const contextError = ref<string>()
  const contextLimit = ref(2)
  async function loadContext() {
    context.value = undefined
    contextError.value = undefined
    // A conversa de um item da origem não existe aqui: nada de `/conversations/:id/turns`.
    // E só depois de a lista chegar: é nela que se sabe se o item é da origem (a rota aberta direto não sabe antes).
    if (!messages.loaded || origin.value || !conversationId.value || turn.value === undefined) return
    try {
      const history = await api<{ turns: ITurn[] }>(`/conversations/${encodeURIComponent(conversationId.value)}/turns`, { query: { limit: contextLimit.value, before: turn.value + 1 } })
      context.value = history.turns
    } catch {
      contextError.value = 'Sem acesso ao histórico desta conversa.'
    }
  }

  watch(
    () => props.id,
    async (id) => {
      // ⚖️ A resposta em escrita fica guardada por mensagem: trocou de tela e voltou, ela está ali.
      draft.value = id ? readDraft(`message:${id}`) : ''
      replyTarget.value = undefined
      contextLimit.value = 2
      if (!id) return
      try {
        await messages.openThread(id)
        await loadContext()
        await nextTick()
        document.querySelector('[data-test="message-end"]')?.scrollIntoView({ block: 'end' })
      } catch (failure) {
        error.value = failure instanceof Error ? failure.message : String(failure)
      }
    },
    { immediate: true },
  )
  watch(draft, (value) => {
    if (props.id) writeDraft(`message:${props.id}`, value)
  })
  watch(turn, (next, previous) => {
    if (next !== previous) void loadContext()
  })
  watch(
    () => messages.loaded,
    (loaded) => {
      if (loaded) void loadContext()
    },
  )

  async function more() {
    contextLimit.value += 3
    await loadContext()
  }

  // 📎 Anexar na resposta: o clipe, colar e arrastar, como na caixa da conversa (ver `useAttachments`).
  const attachments = useAttachments()
  const { files: replyFiles, dragging } = attachments
  const picker = ref<HTMLInputElement>()
  // Outro item: os anexos não vão junto.
  watch(
    () => props.id,
    () => (attachments.files.value = []),
  )

  /** As respostas deste item a caminho (ver `messages.outbox`): a que o fio já trouxe usa a bolha de lá. */
  const outgoing = computed(() => messages.outbox.filter((item) => item.key === props.id))
  /** Os três pontos: a resposta foi e o agente ainda não respondeu no item. */
  const awaiting = computed(() => outgoing.value.some((item) => item.state === 'sent' && item.agentsBefore !== undefined))
  const outgoingTarget = (item: IOutgoingReply) => (item.replyTo ? fio.value.find((candidate) => candidate.id === item.replyTo) : undefined)

  /**
   * ⚖️ Otimista: a resposta entra no fio NA HORA, a caixa limpa e libera. Falhou, a bolha fica marcada com o erro e o texto
   * volta para a caixa (se a pessoa não digitou outra coisa por cima); noutro item, volta para o rascunho do item dela.
   */
  function send() {
    const text = draft.value.trim()
    const key = props.id
    const sentFiles = attachments.files.value
    if ((!text && !sentFiles.length) || !key) return
    const target = replyTarget.value
    error.value = undefined
    draft.value = ''
    attachments.files.value = []
    replyTarget.value = undefined
    void nextTick(() => document.querySelector('[data-test="message-end"]')?.scrollIntoView?.({ block: 'end' }))
    messages.reply(key, text, target, sentFiles).catch(() => {
      if (props.id !== key) {
        if (!readDraft(`message:${key}`).trim()) writeDraft(`message:${key}`, text)
        return
      }
      if (draft.value.trim() || attachments.files.value.length) return
      draft.value = text
      attachments.files.value = sentFiles
      replyTarget.value = target
    })
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  async function archive() {
    if (!props.id) return
    await messages.archive(props.id, !messages.archived)
    await router.push('/messages')
  }

  /** 🗂️ Arquiva (ou devolve à caixa) direto da lista, sem abrir o fio; o aberto fecha junto. */
  async function archiveThread(key: string) {
    await messages.archive(key, !messages.archived)
    if (key === props.id) await router.push('/messages')
  }

  /** 📌 Dá o pedido por resolvido (ou o reabre) direto da lista, pelo menu da linha. */
  async function setThreadStatus(key: string, status: 'resolved' | 'pending') {
    const thread = messages.threads.find((candidate) => candidate.id === key)
    if (!thread?.requestId) return
    try {
      await messages.setStatus(key, thread.requestId, status)
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    }
  }

  /** As resolvidas da caixa, de uma vez: pedido ainda em aberto (pendente ou só respondido) e aviso não lido ficam. */
  const resolvedThreads = computed(() => (messages.archived ? [] : shown.value.filter(isResolved)))
  const archivingResolved = ref(false)
  async function archiveResolved() {
    archivingResolved.value = true
    try {
      for (const thread of resolvedThreads.value) await messages.archive(thread.id, true)
      if (props.id && !messages.threads.some((thread) => thread.id === props.id)) await router.push('/messages')
    } finally {
      archivingResolved.value = false
    }
  }

  /** O menu de três pontos ao lado da busca, no desenho do de Conversas: arquivar as resolvidas e as arquivadas. */
  const { open: menuOpen, root: menuRoot } = usePopover()
  function pick(action: () => unknown) {
    menuOpen.value = false
    void action()
  }

  const snippet = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140)
</script>

<template>
  <MasterDetail :open="!!id" back-to="/messages" back-label="Mensagens" :title="current ? agentName(current.agentId) : undefined">
    <template #list>
      <section class="flex h-full flex-col" data-test="messages-list">
        <header class="flex items-center gap-2 px-4 pt-4 pb-2">
          <h1 class="text-xl font-semibold">{{ messages.archived ? 'Arquivadas' : 'Mensagens' }}</h1>
          <span v-if="messages.unread" class="rounded-full bg-emerald-500 px-1.5 text-xs font-semibold text-zinc-950">{{ messages.unread }}</span>
        </header>
        <div class="flex items-center gap-2 px-4 pb-2 text-xs" data-test="push">
          <template v-if="push === 'on'">
            <Icon name="bell" class="h-3.5 w-3.5 text-emerald-400" />
            <span class="text-zinc-400">Aviso neste aparelho ligado</span>
            <button type="button" class="ml-auto text-zinc-500 hover:text-zinc-300" :disabled="pushBusy" @click="togglePush(false)">Desligar</button>
          </template>
          <button v-else-if="push === 'off'" type="button" class="btn btn-sm btn-ghost -ml-2" :disabled="pushBusy" data-test="push-enable" @click="togglePush(true)">
            <Icon name="bell" class="h-4 w-4" />
            Receber aviso neste aparelho
          </button>
          <span v-else-if="push === 'install'" class="text-zinc-500">Para receber no iPhone: Safari → Compartilhar → Adicionar à Tela de Início, e abra por lá.</span>
          <span v-else-if="push === 'denied'" class="text-zinc-500">Notificações bloqueadas para este site nos ajustes do navegador.</span>
          <span v-if="pushError" class="text-rose-300">{{ pushError }}</span>
        </div>
        <!-- A busca e o menu de três pontos: arquivar as resolvidas e ver as arquivadas. -->
        <div class="flex items-center gap-1.5 px-4 pb-2">
          <input
            v-model="search"
            type="search"
            class="h-9 min-w-0 flex-1 rounded-full bg-zinc-900 px-4 text-sm outline-none placeholder:text-zinc-500"
            placeholder="Buscar por agente ou assunto…"
          />
          <div ref="menuRoot" class="relative shrink-0">
            <button
              type="button"
              class="grid h-9 w-9 place-items-center rounded-full hover:bg-zinc-800"
              :class="menuOpen || messages.archived ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400'"
              title="Mais opções"
              aria-label="Mais opções"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              data-test="messages-menu"
              @click="menuOpen = !menuOpen"
            >
              <Icon name="more" class="h-5 w-5" />
            </button>
            <div v-if="menuOpen" role="menu" class="absolute top-full right-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 text-sm shadow-xl shadow-black/40">
              <div class="border-b border-zinc-800 px-3 py-2 text-xs font-medium text-zinc-500">Mensagens</div>
              <button
                v-if="resolvedThreads.length"
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                :disabled="archivingResolved"
                data-test="archive-resolved"
                @click="pick(archiveResolved)"
              >
                <Icon name="check" class="h-4 w-4 shrink-0 text-zinc-400" />
                <span class="min-w-0 flex-1">
                  <span class="block">Arquivar resolvidas</span>
                  <span class="block truncate text-xs text-zinc-500">Pedidos resolvidos e avisos já lidos</span>
                </span>
                <span class="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-400" data-test="resolved-count">{{ resolvedThreads.length }}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-zinc-800"
                :class="messages.archived ? 'text-emerald-300' : 'text-zinc-200'"
                data-test="archived-toggle"
                @click="pick(() => messages.showArchived(!messages.archived))"
              >
                <Icon name="archive" class="h-4 w-4 shrink-0 text-zinc-400" />
                <span class="min-w-0 flex-1">
                  <span class="block">{{ messages.archived ? 'Voltar à caixa de entrada' : 'Arquivadas' }}</span>
                  <span class="block truncate text-xs text-zinc-500">{{ messages.archived ? 'As mensagens em aberto' : 'As mensagens que você guardou' }}</span>
                </span>
              </button>
            </div>
          </div>
        </div>
        <p v-if="messages.loaded && !shown.length" class="px-4 py-8 text-center text-sm text-zinc-500">
          {{ messages.archived ? 'Nenhuma mensagem arquivada.' : 'Nenhuma mensagem. Quando um agente precisar de você, ela aparece aqui.' }}
        </p>
        <ul class="min-h-0 flex-1 overflow-y-auto px-2">
          <li v-for="thread in shown" :key="thread.id">
            <MessageThreadRow
              :thread="thread"
              :active="thread.id === id"
              :archived="messages.archived"
              :name="agentName(thread.agentId)"
              :provider="agentProvider(thread.agentId)"
              :speaking="speech.current?.thread === thread.id"
              @archive="archiveThread"
              @status="setThreadStatus"
            />
          </li>
        </ul>
      </section>
    </template>

    <template #actions>
      <button v-if="id" type="button" class="btn btn-sm btn-ghost" :title="messages.archived ? 'Voltar à caixa' : 'Arquivar'" data-test="message-archive-mobile" @click="archive">
        <Icon name="archive" class="h-4 w-4" />
      </button>
    </template>

    <template #detail>
      <section v-if="id" class="flex h-full min-h-0 flex-col" data-test="message-detail">
        <header class="flex items-center gap-3 border-b border-zinc-800/80 px-4 py-3 max-lg:hidden">
          <AgentAvatar v-if="current" :name="agentName(current.agentId)" :provider="agentProvider(current.agentId)" size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium">{{ current?.title || (current ? agentName(current.agentId) : '') }}</span>
            <span v-if="current" class="block truncate text-xs text-zinc-500">{{ agentName(current.agentId) }}{{ current.projectId ? ` · ${current.projectId}` : '' }}</span>
          </span>
          <span v-if="current?.pending" class="shrink-0 rounded-full bg-amber-500/20 px-2 text-xs font-semibold text-amber-300" data-test="thread-pending-count">
            {{ current.pending }} {{ current.pending === 1 ? 'pendente' : 'pendentes' }}
          </span>
          <button type="button" class="btn btn-sm btn-ghost" :title="messages.archived ? 'Voltar à caixa' : 'Arquivar'" @click="archive">
            <Icon name="archive" class="h-4 w-4" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div class="mx-auto flex max-w-3xl flex-col gap-3">
            <!-- O contexto: o que estava acontecendo na conversa quando o agente escreveu. -->
            <section v-if="origin" class="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-500" data-test="message-origin">
              <span>
                Esta conversa está no servidor ({{ origin.projectId }}).<template v-if="origin.stale"> A origem não respondeu: esta é a última lista que ela deu.</template>
              </span>
              <a
                v-if="originLink"
                :href="originLink"
                target="_blank"
                rel="noopener noreferrer"
                class="ml-auto shrink-0 text-emerald-300 hover:underline"
                data-test="message-open-origin"
              >
                Abrir na conversa →
              </a>
            </section>
            <section v-else-if="turn !== undefined" class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" data-test="message-context">
              <div class="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                <span>Na conversa, até o momento em que {{ current ? agentName(current.agentId) : 'o agente' }} escreveu</span>
                <RouterLink :to="{ path: `/c/${conversationId}`, query: { turn: String(turn) } }" class="ml-auto text-emerald-300 hover:underline" data-test="message-open-turn">
                  Abrir na conversa →
                </RouterLink>
              </div>
              <p v-if="contextError" class="text-xs text-zinc-500">{{ contextError }}</p>
              <template v-else-if="context">
                <button
                  v-if="context.length >= contextLimit && (context[0]?.index ?? 0) > 0"
                  type="button"
                  class="btn btn-sm btn-ghost mb-2"
                  data-test="message-more"
                  @click="more"
                >
                  Ler mais acima
                </button>
                <div v-for="item in context" :key="item.index" class="mb-3 flex flex-col gap-1.5 text-sm">
                  <div class="self-end rounded-2xl rounded-br-md bg-violet-500/15 px-3 py-1.5 text-zinc-200 max-w-[85%] whitespace-pre-wrap">
                    {{ snippet(item.request) }}{{ item.request.length > 140 ? '…' : '' }}
                  </div>
                  <div
                    class="prose-agent max-h-48 overflow-hidden rounded-2xl rounded-bl-md bg-zinc-800/70 px-3 py-1.5 text-zinc-300 max-w-[90%]"
                    v-html="renderMarkdown(item.text)"
                  />
                </div>
              </template>
              <p v-else class="text-xs text-zinc-500">Carregando o contexto…</p>
            </section>

            <!-- O fio: o que o agente escreveu e o que foi respondido. -->
            <template v-for="message in shownFio" :key="message.id">
              <div v-if="message.from === 'agent'" class="flex max-w-[90%] flex-col gap-1 self-start" :data-message-id="message.id" data-test="message-agent">
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="LEVEL[message.level]"
                    class="rounded-full px-2 text-[10px] font-semibold"
                    :class="message.level === 'urgent' ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'"
                  >
                    {{ LEVEL[message.level] }}
                  </span>
                  <span
                    v-if="message.status"
                    class="rounded-full px-2 text-[10px] font-semibold"
                    :class="STATUS[message.status].css"
                    :data-test="`message-status-${message.status}`"
                  >
                    {{ statusLabel(message) }}
                  </span>
                </div>
                <div class="rounded-2xl rounded-bl-md bg-zinc-800/90 px-3.5 py-2 text-sm" :class="replyTarget === message.id ? 'ring-1 ring-emerald-500/60' : ''">
                  <strong v-if="message.title" class="mb-1 block">{{ message.title }}</strong>
                  <div class="prose-agent wrap-anywhere" v-html="renderMarkdown(message.body)" />
                </div>
                <div class="flex items-center gap-2 text-[11px] text-zinc-500">
                  <span :title="fullTime(message.createdAt)">{{ shortTime(message.createdAt) }}</span>
                  <template v-if="message.status">
                    <button type="button" class="text-emerald-300 hover:underline" data-test="message-reply-to" @click="replyTo(message)">Responder</button>
                    <button
                      v-if="message.status === 'resolved'"
                      type="button"
                      class="hover:text-zinc-300 hover:underline"
                      data-test="message-reopen"
                      @click="setStatus(message, 'pending')"
                    >
                      Reabrir
                    </button>
                    <button v-else type="button" class="hover:text-zinc-300 hover:underline" data-test="message-resolve" @click="setStatus(message, 'resolved')">
                      Marcar resolvido
                    </button>
                  </template>
                </div>
              </div>
              <div v-else class="flex max-w-[85%] flex-col items-end gap-1 self-end" data-test="message-person">
                <button v-if="requestOf(message)" type="button" class="text-[11px] text-zinc-500 hover:text-zinc-300" data-test="message-in-reply-to" @click="goToRequest(message.replyTo!)">
                  ↳ em resposta a {{ requestLabel(requestOf(message)!) }}
                </button>
                <div v-if="message.body" class="rounded-2xl rounded-br-md bg-violet-600/80 px-3.5 py-2 text-sm whitespace-pre-wrap text-white">{{ message.body }}</div>
                <div v-if="message.files?.length" class="flex flex-wrap justify-end gap-1.5" data-test="message-person-files">
                  <span v-for="(file, index) in message.files" :key="index" class="flex items-center gap-1 rounded-full bg-violet-600/30 px-2.5 py-1 text-xs text-violet-100">
                    <Icon name="clip" class="h-3.5 w-3.5" />
                    {{ file.name }}
                  </span>
                </div>
                <span class="text-[11px] text-zinc-500">{{ shortTime(message.createdAt) }}</span>
              </div>
            </template>
            <!-- A resposta a caminho: na hora, antes de o servidor responder; a que o fio já trouxe usa a bolha de lá. -->
            <template v-for="item in outgoing" :key="item.id">
              <div v-if="!item.confirmed" class="flex max-w-[85%] flex-col items-end gap-1 self-end" data-test="message-outgoing" :data-state="item.state">
                <span v-if="outgoingTarget(item)" class="text-[11px] text-zinc-500">↳ em resposta a {{ requestLabel(outgoingTarget(item)!) }}</span>
                <div
                  v-if="item.body"
                  class="rounded-2xl rounded-br-md px-3.5 py-2 text-sm whitespace-pre-wrap text-white"
                  :class="item.state === 'failed' ? 'bg-violet-600/40 ring-1 ring-rose-500/60' : item.state === 'sending' ? 'bg-violet-600/60' : 'bg-violet-600/80'"
                >
                  {{ item.body }}
                </div>
                <div v-if="item.files?.length" class="flex flex-wrap justify-end gap-1.5" data-test="message-outgoing-files">
                  <span v-for="(name, index) in item.files" :key="index" class="flex items-center gap-1 rounded-full bg-violet-600/30 px-2.5 py-1 text-xs text-violet-100">
                    <Icon name="clip" class="h-3.5 w-3.5" />
                    {{ name }}
                  </span>
                </div>
                <span v-if="item.state === 'sending'" class="text-[11px] text-zinc-500">Enviando…</span>
                <span v-else-if="item.state === 'sent'" class="text-[11px] text-zinc-500">{{ item.queued ? 'Enviada · entra no turno em andamento' : 'Enviada' }}</span>
                <span v-else class="flex items-center gap-2 text-[11px] text-rose-300" data-test="message-outgoing-error">
                  Não enviada: {{ item.error }}
                  <button type="button" class="text-zinc-400 hover:text-zinc-100" title="Tirar da tela" aria-label="Tirar a mensagem não enviada" @click="messages.dismissOutgoing(item.id)">×</button>
                </span>
              </div>
            </template>
            <div v-if="awaiting" class="flex h-9 items-center gap-1 self-start rounded-2xl rounded-bl-md bg-zinc-800/90 px-3.5" aria-label="Aguardando a resposta do agente" data-test="message-awaiting">
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
              <span class="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
            </div>
            <div data-test="message-end" />
          </div>
        </div>
        <form
          class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3"
          :class="dragging ? 'bg-emerald-500/10 outline-2 -outline-offset-2 outline-emerald-500/60 outline-dashed' : ''"
          data-test="message-reply-form"
          @submit.prevent="send"
          @dragover="attachments.onDragOver"
          @dragleave="attachments.onDragLeave"
          @drop="attachments.onDrop"
        >
          <p v-if="error" class="mb-2 text-sm text-rose-300">{{ error }}</p>
          <div v-if="targetMessage" class="mx-auto mb-2 flex max-w-3xl items-center gap-2 text-xs" data-test="reply-target">
            <span class="min-w-0 truncate rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">Respondendo: {{ requestLabel(targetMessage) }}</span>
            <button type="button" class="text-zinc-400 hover:text-zinc-100" title="Cancelar" aria-label="Cancelar a resposta ao pedido" data-test="reply-target-cancel" @click="replyTarget = undefined">
              ×
            </button>
          </div>
          <div v-if="replyFiles.length" class="mx-auto mb-2 flex max-w-3xl flex-wrap gap-1.5" data-test="message-reply-files">
            <span v-for="(file, index) in replyFiles" :key="index" class="flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs">
              {{ file.name }}
              <button type="button" class="text-zinc-400 hover:text-white" :aria-label="`Tirar ${file.name}`" @click="replyFiles.splice(index, 1)">
                <Icon name="x" class="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          <div class="mx-auto flex max-w-3xl items-end gap-2">
            <button
              type="button"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              title="Anexar"
              aria-label="Anexar"
              data-test="message-reply-attach"
              @click="picker?.click()"
            >
              <Icon name="clip" class="h-5 w-5" />
            </button>
            <input ref="picker" type="file" multiple class="hidden" data-test="message-reply-picker" @change="attachments.attach" />
            <textarea
              ref="composer"
              v-model="draft"
              rows="1"
              class="max-h-[200px] min-h-10 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60"
              :placeholder="targetMessage ? 'Responder a este pedido…' : current ? `Responder a ${agentName(current.agentId)} (vai para a conversa)` : 'Responder'"
              data-test="message-reply"
              @keydown="onKey"
              @paste="attachments.onPaste"
            />
            <button
              type="submit"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"
              :disabled="!draft.trim() && !replyFiles.length"
              title="Enviar"
            >
              <Icon name="send" class="h-5 w-5" />
            </button>
          </div>
        </form>
      </section>
      <div v-else class="grid h-full place-items-center p-6 text-center text-sm text-zinc-500">
        <div>
          <Icon name="bell" class="mx-auto mb-2 h-8 w-8 text-zinc-600" />
          Escolha uma mensagem.
        </div>
      </div>
    </template>
  </MasterDetail>
</template>
