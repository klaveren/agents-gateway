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
  import { useAgentsStore } from '@/stores/agents'
  import { useMessagesStore, type IPersonMessage, type IPersonThread } from '@/stores/messages'

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

  const error = ref<string>()
  const draft = ref('')
  const sending = ref(false)
  const sentNote = ref<string>()
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
      sentNote.value = undefined
      draft.value = ''
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

  async function send() {
    const text = draft.value.trim()
    if (!text || !props.id || sending.value) return
    sending.value = true
    error.value = undefined
    try {
      const result = await messages.reply(props.id, text, replyTarget.value)
      draft.value = ''
      replyTarget.value = undefined
      sentNote.value = result.queued
        ? 'Enviado: a conversa está rodando, sua resposta entra no turno atual. A resposta do agente aparece aqui.'
        : 'Enviado para a conversa. A resposta do agente aparece aqui.'
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      sending.value = false
    }
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

  /** As lidas da caixa, de uma vez: o que ainda precisa de você (não lida) fica. */
  const readThreads = computed(() => (messages.archived ? [] : shown.value.filter((thread) => !thread.unread)))
  const archivingRead = ref(false)
  async function archiveRead() {
    archivingRead.value = true
    try {
      for (const thread of readThreads.value) await messages.archive(thread.id, true)
      if (props.id && !messages.threads.some((thread) => thread.id === props.id)) await router.push('/messages')
    } finally {
      archivingRead.value = false
    }
  }

  const snippet = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140)
</script>

<template>
  <MasterDetail :open="!!id" back-to="/messages" back-label="Mensagens" :title="current ? agentName(current.agentId) : undefined">
    <template #list>
      <section class="flex h-full flex-col" data-test="messages-list">
        <header class="flex items-center gap-2 px-4 pt-4 pb-2">
          <h1 class="text-xl font-semibold">Mensagens</h1>
          <span v-if="messages.unread" class="rounded-full bg-emerald-500 px-1.5 text-xs font-semibold text-zinc-950">{{ messages.unread }}</span>
          <button
            v-if="readThreads.length"
            type="button"
            class="btn btn-sm btn-ghost ml-auto"
            :disabled="archivingRead"
            title="Arquivar as conversas já lidas"
            data-test="archive-read"
            @click="archiveRead"
          >
            <Icon name="archive" class="h-4 w-4" />
            Arquivar lidas
          </button>
          <button type="button" class="btn btn-sm btn-ghost" :class="readThreads.length ? '' : 'ml-auto'" @click="messages.showArchived(!messages.archived)">
            {{ messages.archived ? 'Caixa de entrada' : 'Arquivadas' }}
          </button>
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
        <div class="px-4 pb-2">
          <input
            v-model="search"
            type="search"
            class="h-9 w-full rounded-full bg-zinc-900 px-4 text-sm outline-none placeholder:text-zinc-500"
            placeholder="Buscar por agente ou assunto…"
          />
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
              @archive="archiveThread"
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
                <div class="rounded-2xl rounded-br-md bg-violet-600/80 px-3.5 py-2 text-sm whitespace-pre-wrap text-white">{{ message.body }}</div>
                <span class="text-[11px] text-zinc-500">{{ shortTime(message.createdAt) }}</span>
              </div>
            </template>
            <p v-if="sentNote" class="self-end text-xs text-zinc-500">{{ sentNote }}</p>
            <div data-test="message-end" />
          </div>
        </div>
        <form class="border-t border-zinc-800/80 bg-zinc-900/60 px-4 py-3" @submit.prevent="send">
          <p v-if="error" class="mb-2 text-sm text-rose-300">{{ error }}</p>
          <div v-if="targetMessage" class="mx-auto mb-2 flex max-w-3xl items-center gap-2 text-xs" data-test="reply-target">
            <span class="min-w-0 truncate rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">Respondendo: {{ requestLabel(targetMessage) }}</span>
            <button type="button" class="text-zinc-400 hover:text-zinc-100" title="Cancelar" aria-label="Cancelar a resposta ao pedido" data-test="reply-target-cancel" @click="replyTarget = undefined">
              ×
            </button>
          </div>
          <div class="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              ref="composer"
              v-model="draft"
              rows="1"
              class="max-h-[200px] min-h-10 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60"
              :placeholder="targetMessage ? 'Responder a este pedido…' : current ? `Responder a ${agentName(current.agentId)} (vai para a conversa)` : 'Responder'"
              data-test="message-reply"
              @keydown="onKey"
            />
            <button
              type="submit"
              class="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-500 text-zinc-950 hover:bg-emerald-400 disabled:opacity-40"
              :disabled="sending || !draft.trim()"
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
