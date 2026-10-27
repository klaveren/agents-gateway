import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, openStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import type { IConversation, IConversationPage } from '@/lib/types'
import { useProjectsStore } from './projects'

export interface IConversationFilters {
  q: string
  agentId: string
  classification: string
}

export type TConversationEvent = { type: 'conversation.updated'; session: IConversation } | { type: 'conversation.deleted'; sessionId: string }

const PAGE_SIZE = 30
const RECONNECT_MS = 3_000

/** A conversa casa com o filtro aberto? Decide se um evento ao vivo entra na lista. */
export function matchesFilters(conversation: IConversation, filters: IConversationFilters): boolean {
  if (filters.agentId && conversation.agentId !== filters.agentId) return false
  if (filters.classification && conversation.classification !== filters.classification) return false

  const term = filters.q.trim().toLowerCase()
  if (!term) return true
  const owner = conversation.metadata?.owner
  return [conversation.title, owner?.email, owner?.id, owner?.account].some((value) => value?.toLowerCase().includes(term))
}

/**
 * Aplica um evento à lista: a conversa atualizada SOBE (ou entra, se casa com o filtro); a apagada sai.
 *
 * ⚖️ Pura, e exportada: é a regra da caixa de entrada, e testá-la não pode depender de rede.
 */
export function applyEvent(items: IConversation[], event: TConversationEvent, filters: IConversationFilters): { items: IConversation[]; added: boolean; removed: boolean } {
  const id = event.type === 'conversation.updated' ? event.session.id : event.sessionId
  const existed = items.some((item) => item.id === id)
  const rest = items.filter((item) => item.id !== id)

  if (event.type === 'conversation.deleted' || !matchesFilters(event.session, filters)) return { items: rest, added: false, removed: existed }

  const next = [...rest]
  const at = next.findIndex((item) => item.updatedAt < event.session.updatedAt)
  next.splice(at === -1 ? next.length : at, 0, event.session)

  return { items: next, added: !existed, removed: false }
}

/**
 * A caixa de entrada: as conversas gravadas, de todos os agentes.
 *
 * ⚖️ DOIS MODOS, decididos pelo gateway e não pela tela: o admin pagina TODAS no servidor
 * (`scope=all&page`), com busca e contagens; os demais recebem as suas (`/conversations`) e a busca
 * é feita aqui, sobre o que veio.
 */
export const useConversationsStore = defineStore('conversations', () => {
  const items = ref<IConversation[]>([])
  const total = ref(0)
  const facets = ref<IConversationPage['facets']>()
  const page = ref(1)
  const scope = ref<'all' | 'mine'>('mine')
  const loading = ref(false)
  const error = ref<string>()
  const filters = ref<IConversationFilters>({ q: '', agentId: '', classification: '' })
  const unread = ref(new Set<string>())
  const live = ref(false)
  const selectedId = ref<string>()

  let all: IConversation[] = []
  let stream: AbortController | undefined
  let generation = 0

  const hasMore = computed(() => scope.value === 'all' && items.value.length < total.value)

  async function load(admin: boolean): Promise<void> {
    scope.value = admin ? 'all' : 'mine'
    page.value = 1
    const current = ++generation
    loading.value = true
    error.value = undefined

    try {
      if (admin) {
        const result = await fetchPage(1)
        if (current !== generation) return
        items.value = result.sessions
        total.value = result.total ?? result.sessions.length
        facets.value = result.facets
      } else {
        const result = await api<IConversationPage>('/conversations', { query: { limit: 500, ...useProjectsStore().query } })
        if (current !== generation) return
        all = result.sessions
        refilter()
      }
    } catch (failure) {
      if (current === generation) error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  /**
   * ⚠️ A resposta de uma página pertence ao filtro (e ao usuário) de QUANDO foi pedida. Se `load` ou
   * `reset` rodou no meio, a geração mudou e a página velha não pode entrar na lista de agora.
   */
  async function loadMore(): Promise<void> {
    if (!hasMore.value || loading.value) return
    const current = generation
    loading.value = true
    try {
      const result = await fetchPage(page.value + 1)
      if (current !== generation) return
      page.value += 1
      const known = new Set(items.value.map((item) => item.id))
      items.value = [...items.value, ...result.sessions.filter((item) => !known.has(item.id))]
      total.value = result.total ?? total.value
    } catch (failure) {
      if (current === generation) error.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      if (current === generation) loading.value = false
    }
  }

  function fetchPage(number: number): Promise<IConversationPage> {
    const { q, agentId, classification } = filters.value
    return api<IConversationPage>('/conversations', { query: { scope: 'all', page: number, pageSize: PAGE_SIZE, q, agentId, classification, ...useProjectsStore().query } })
  }

  /** Sem paginação no servidor, o filtro é aplicado aqui sobre a lista inteira. */
  function refilter(): void {
    items.value = all.filter((item) => matchesFilters(item, filters.value))
    total.value = items.value.length
    const counts: Record<string, number> = {}
    for (const item of all) counts[item.agentId] = (counts[item.agentId] ?? 0) + 1
    facets.value = { agent: counts, classification: {}, provider: {} }
  }

  function setFilters(patch: Partial<IConversationFilters>, admin: boolean): Promise<void> | void {
    filters.value = { ...filters.value, ...patch }
    if (admin) return load(true)
    refilter()
  }

  function apply(event: TConversationEvent): void {
    const gone = event.type === 'conversation.deleted' ? (items.value.find((item) => item.id === event.sessionId) ?? all.find((item) => item.id === event.sessionId)) : undefined
    const known = event.type === 'conversation.updated' && (items.value.some((item) => item.id === event.session.id) || all.some((item) => item.id === event.session.id))
    if (scope.value === 'mine') {
      all = applyEvent(all, event, { q: '', agentId: '', classification: '' }).items
    }

    const result = applyEvent(items.value, event, filters.value)
    items.value = result.items
    if (result.added) total.value += 1
    // A aba do agente conta a conversa nova na hora; o resto das contagens acerta na próxima leitura.
    if (event.type === 'conversation.updated' && !known && facets.value) {
      const agent = facets.value.agent
      facets.value = { ...facets.value, agent: { ...agent, [event.session.agentId]: (agent[event.session.agentId] ?? 0) + 1 } }
    }
    if (gone && facets.value) {
      const agent = { ...facets.value.agent, [gone.agentId]: Math.max((facets.value.agent[gone.agentId] ?? 1) - 1, 0) }
      if (!agent[gone.agentId]) delete agent[gone.agentId]
      facets.value = { ...facets.value, agent }
    }
    if (result.removed) total.value = Math.max(total.value - 1, 0)

    if (event.type === 'conversation.updated' && event.session.id !== selectedId.value) unread.value = new Set([...unread.value, event.session.id])
  }

  function select(id: string | undefined): void {
    selectedId.value = id
    if (id && unread.value.has(id)) {
      const next = new Set(unread.value)
      next.delete(id)
      unread.value = next
    }
  }

  /**
   * Assina `/conversations/events` e reconecta sozinho.
   *
   * ⚠️ Ao reconectar, recarrega a lista: o que mudou enquanto a conexão estava caída não foi
   * entregue a ninguém, e só a releitura fecha esse buraco.
   */
  function subscribe(admin: boolean): void {
    stream?.abort()
    const controller = new AbortController()
    stream = controller

    const run = async (first: boolean) => {
      while (!controller.signal.aborted) {
        try {
          const body = await openStream('/conversations/events', { signal: controller.signal, query: useProjectsStore().query })
          live.value = true
          if (!first) void load(admin)
          first = false
          for await (const frame of readSse(body)) {
            if (controller.signal.aborted) return
            apply(frame.data as TConversationEvent)
          }
        } catch {
          // Caiu ou foi abortado: o laço decide.
        }
        live.value = false
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS))
      }
    }
    void run(true)
  }

  function unsubscribe(): void {
    stream?.abort()
    stream = undefined
    live.value = false
  }

  /** Logout: zera lista, contadores e a conversa selecionada, e fecha a assinatura. Respostas em voo ficam obsoletas. */
  function reset(): void {
    generation++
    unsubscribe()
    all = []
    items.value = []
    total.value = 0
    facets.value = undefined
    page.value = 1
    scope.value = 'mine'
    loading.value = false
    error.value = undefined
    filters.value = { q: '', agentId: '', classification: '' }
    unread.value = new Set()
    selectedId.value = undefined
  }

  function find(id: string): IConversation | undefined {
    return items.value.find((item) => item.id === id) ?? all.find((item) => item.id === id)
  }

  async function share(id: string, shared: boolean): Promise<{ shareId?: string }> {
    const result = await api<{ shared: boolean; shareId?: string }>(`/conversations/${encodeURIComponent(id)}/share`, { method: 'PUT', body: { shared } })
    const conversation = find(id)
    if (conversation) Object.assign(conversation, { shared: result.shared, shareId: result.shareId })
    return result
  }

  async function remove(id: string): Promise<void> {
    await api(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
    apply({ type: 'conversation.deleted', sessionId: id })
  }

  return {
    items,
    total,
    facets,
    scope,
    loading,
    error,
    filters,
    unread,
    live,
    selectedId,
    hasMore,
    load,
    loadMore,
    setFilters,
    apply,
    select,
    subscribe,
    unsubscribe,
    reset,
    find,
    share,
    remove,
  }
})
