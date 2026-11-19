<script setup lang="ts">
  import { computed, nextTick, onMounted, ref, watch } from 'vue'
  import { useRoute, useRouter } from 'vue-router'
  import AgentAvatar from '@/components/AgentAvatar.vue'
  import Icon from '@/components/Icon.vue'
  import MasterDetail from '@/components/MasterDetail.vue'
  import { api } from '@/lib/api'
  import { shortTime, fullTime } from '@/lib/format'
  import { renderMarkdown } from '@/lib/markdown'
  import type { ITurn } from '@/lib/types'
  import { useAgentsStore } from '@/stores/agents'
  import { useMessagesStore, type IPersonThread } from '@/stores/messages'

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

  const LEVEL: Record<string, string> = { info: '', attention: 'Precisa de você', urgent: 'Urgente' }

  onMounted(() => {
    void messages.load().catch((failure) => (error.value = failure instanceof Error ? failure.message : String(failure)))
    void agents.ensure().catch(() => undefined)
  })

  const agentName = (id: string) => agents.byId.get(id)?.name ?? id
  const agentProvider = (id: string) => agents.byId.get(id)?.providers?.[0]?.id ?? ''
  const shown = computed(() => {
    const term = search.value.trim().toLowerCase()
    return term ? messages.threads.filter((thread) => `${agentName(thread.agentId)} ${thread.title ?? ''} ${thread.last.body}`.toLowerCase().includes(term)) : messages.threads
  })
  const current = computed<IPersonThread | undefined>(() => messages.threads.find((thread) => thread.conversationId === props.id))
  const fio = computed(() => (messages.open?.conversationId === props.id ? (messages.open?.messages ?? []) : []))
  /** O turno do contexto: o da última mensagem do agente (é ali que ele precisou da pessoa). */
  const turn = computed(() => [...fio.value].reverse().find((message) => message.from === 'agent' && message.turn !== undefined)?.turn)

  // O CONTEXTO: os turnos até aquele em que o agente escreveu; "Ler mais acima" traz mais.
  const context = ref<ITurn[]>()
  const contextError = ref<string>()
  const contextLimit = ref(2)
  async function loadContext() {
    context.value = undefined
    contextError.value = undefined
    if (!props.id || turn.value === undefined) return
    try {
      const history = await api<{ turns: ITurn[] }>(`/conversations/${encodeURIComponent(props.id)}/turns`, { query: { limit: contextLimit.value, before: turn.value + 1 } })
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
      const result = await messages.reply(props.id, text)
      draft.value = ''
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

  const snippet = (text: string) => text.replace(/\s+/g, ' ').slice(0, 140)
</script>

<template>
  <MasterDetail :open="!!id" back-to="/messages" back-label="Mensagens" :title="current ? agentName(current.agentId) : undefined">
    <template #list>
      <section class="flex h-full flex-col" data-test="messages-list">
        <header class="flex items-center gap-2 px-4 pt-4 pb-2">
          <h1 class="text-xl font-semibold">Mensagens</h1>
          <span v-if="messages.unread" class="rounded-full bg-emerald-500 px-1.5 text-xs font-semibold text-zinc-950">{{ messages.unread }}</span>
          <button type="button" class="btn btn-sm btn-ghost ml-auto" @click="messages.showArchived(!messages.archived)">
            {{ messages.archived ? 'Caixa de entrada' : 'Arquivadas' }}
          </button>
        </header>
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
          <li v-for="thread in shown" :key="thread.conversationId">
            <RouterLink
              :to="`/messages/${thread.conversationId}`"
              class="flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-zinc-900"
              :class="thread.conversationId === id ? 'bg-zinc-900' : ''"
              data-test="message-thread"
            >
              <AgentAvatar :name="agentName(thread.agentId)" :provider="agentProvider(thread.agentId)" size="sm" />
              <span class="min-w-0 flex-1">
                <span class="flex items-baseline gap-2">
                  <span class="truncate text-sm" :class="thread.unread ? 'font-semibold text-zinc-50' : 'text-zinc-200'">{{ thread.title || agentName(thread.agentId) }}</span>
                  <span class="ml-auto shrink-0 text-xs text-zinc-500">{{ shortTime(thread.last.createdAt) }}</span>
                </span>
                <span class="flex items-center gap-2">
                  <span class="min-w-0 flex-1 truncate text-xs text-zinc-400">
                    <template v-if="thread.last.from === 'person'">Você:</template>
                    <template v-else>{{ agentName(thread.agentId) }}:</template>
                    {{ snippet(thread.last.body) }}
                  </span>
                  <span
                    v-if="thread.last.level !== 'info' && thread.last.from === 'agent'"
                    class="h-2 w-2 shrink-0 rounded-full"
                    :class="thread.last.level === 'urgent' ? 'bg-rose-400' : 'bg-amber-400'"
                  />
                  <span v-if="thread.unread" class="shrink-0 rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-zinc-950">{{ thread.unread }}</span>
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>

    <template #detail>
      <section v-if="id" class="flex h-full min-h-0 flex-col" data-test="message-detail">
        <header class="flex items-center gap-3 border-b border-zinc-800/80 px-4 py-3 max-lg:hidden">
          <AgentAvatar v-if="current" :name="agentName(current.agentId)" :provider="agentProvider(current.agentId)" size="sm" />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium">{{ current?.title || (current ? agentName(current.agentId) : '') }}</span>
            <span v-if="current" class="block truncate text-xs text-zinc-500">{{ agentName(current.agentId) }}{{ current.projectId ? ` · ${current.projectId}` : '' }}</span>
          </span>
          <button type="button" class="btn btn-sm btn-ghost" :title="messages.archived ? 'Voltar à caixa' : 'Arquivar'" @click="archive">
            <Icon name="archive" class="h-4 w-4" />
          </button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div class="mx-auto flex max-w-3xl flex-col gap-3">
            <!-- O contexto: o que estava acontecendo na conversa quando o agente escreveu. -->
            <section v-if="turn !== undefined" class="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3" data-test="message-context">
              <div class="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                <span>Na conversa, até o momento em que {{ current ? agentName(current.agentId) : 'o agente' }} escreveu</span>
                <RouterLink :to="{ path: `/c/${id}`, query: { turn: String(turn) } }" class="ml-auto text-emerald-300 hover:underline" data-test="message-open-turn">
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
            <template v-for="message in fio" :key="message.id">
              <div v-if="message.from === 'agent'" class="flex max-w-[90%] flex-col gap-1 self-start" data-test="message-agent">
                <span
                  v-if="LEVEL[message.level]"
                  class="self-start rounded-full px-2 text-[10px] font-semibold"
                  :class="message.level === 'urgent' ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300'"
                >
                  {{ LEVEL[message.level] }}
                </span>
                <div class="rounded-2xl rounded-bl-md bg-zinc-800/90 px-3.5 py-2 text-sm">
                  <strong v-if="message.title" class="mb-1 block">{{ message.title }}</strong>
                  <div class="prose-agent wrap-anywhere" v-html="renderMarkdown(message.body)" />
                </div>
                <span class="text-[11px] text-zinc-500" :title="fullTime(message.createdAt)">{{ shortTime(message.createdAt) }}</span>
              </div>
              <div v-else class="flex max-w-[85%] flex-col items-end gap-1 self-end" data-test="message-person">
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
          <div class="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              v-model="draft"
              rows="1"
              class="max-h-[200px] min-h-10 flex-1 resize-none rounded-2xl bg-zinc-800 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-500 focus:ring-1 focus:ring-emerald-500/60"
              :placeholder="current ? `Responder a ${agentName(current.agentId)} (vai para a conversa)` : 'Responder'"
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
