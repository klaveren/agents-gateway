import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, openStream } from '@/lib/api'
import { readSse } from '@/lib/sse'
import type { IAgentEvent, IConversation, IConversationPage } from '@/lib/types'
import { useProjectsStore } from './projects'
import { catalogChanged, catalogResync, type ICatalogChanged } from './catalogSync'

export interface IConversationFilters {
  q: string
  agentId: string
  classification: string
}

export type TConversationEvent = { type: 'conversation.updated'; session: IConversation } | { type: 'conversation.deleted'; sessionId: string }
/** Um turno começou ou acabou numa conversa (venha da tela, da API ou de um agendamento). */
export type TRunningEvent = { type: 'conversation.running'; sessionId: string } | { type: 'conversation.idle'; sessionId: string }
/** O turno ao vivo da conversa acompanhada (ver `follow`), no mesmo stream. `turn.idle`: nada rodando ao começar. */
export type TTurnFrame =
  | { type: 'turn.started'; sessionId: string; turn: { request: string; events: IAgentEvent[] } }
  | { type: 'turn.event'; sessionId: string; event: IAgentEvent }
  | { type: 'turn.finished'; sessionId: string }
  | { type: 'turn.idle'; sessionId: string }
type TStreamFrame = TConversationEvent | TRunningEvent | TTurnFrame | { type: 'stream.ready'; streamId: string } | { type: 'catalog.changed'; changes: ICatalogChanged[] }

const PAGE_SIZE = 30
const RECONNECT_MS = 3_000

/** A conversa casa com o filtro aberto? Decide se um evento ao vivo entra na lista. */
export function matchesFilters(conversation: IConversation, filters: IConversationFilters): boolean {
  // ⚖️ A caixa de entrada é o que se vê: a delegada aparece dentro da conversa que a originou, não na lista nem na conta.
  if (conversation.metadata?.delegatedBy) return false
  if (filters.agentId && conversation.agentId !== filters.agentId) return false
  if (filters.classification && conversation.classification !== filters.classification) return false

  const term = filters.q.trim().toLowerCase()
  if (!term) return true
  const owner = conversation.metadata?.owner
  // O id também (`gw_…`): acha a conversa que alguém citou.
  return [conversation.title, owner?.email, owner?.id, owner?.account, conversation.id].some((value) => value?.toLowerCase().includes(term))
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

  // ⚖️ Arquivada sai da caixa de entrada (e volta, quando o `archivedAt` some): quem decide é o evento, não a tela.
  if (event.type === 'conversation.deleted' || event.session.archivedAt || !matchesFilters(event.session, filters)) return { items: rest, added: false, removed: existed }

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
  /** Quantas arquivadas existem: a entrada "Arquivadas (N)" da lista. */
  const archivedCount = ref(0)
  /** A lista de arquivadas. ⚠️ Pode estar parcial até `loadArchived` rodar (guarda só o que passou por aqui). */
  const archivedItems = ref<IConversation[]>([])
  const archivedLoading = ref(false)
  /** Qual lista a tela mostra: a caixa de entrada ou as arquivadas. */
  const view = ref<'inbox' | 'archived'>('inbox')
  /** Falha de arquivar/desarquivar/apagar na linha: a lista mostra e dispensa. */
  const actionError = ref<string>()
  const facets = ref<IConversationPage['facets']>()
  const page = ref(1)
  const scope = ref<'all' | 'mine'>('mine')
  /**
   * ⚖️ O admin vê a PRÓPRIA caixa de entrada, como qualquer pessoa; "De todos" liga o monitor (todas as conversas, de
   * todo mundo). Desligado por padrão: com a esteira abrindo uma conversa por disparo, a caixa seria dela.
   */
  const everyone = ref(false)
  const loading = ref(false)
  const error = ref<string>()
  const filters = ref<IConversationFilters>({ q: '', agentId: '', classification: '' })
  const unread = ref(new Set<string>())
  /** As conversas com um turno rodando agora. Ao (re)conectar, o servidor manda as que já estão. */
  const running = ref(new Set<string>())
  const live = ref(false)
  const selectedId = ref<string>()

  let all: IConversation[] = []
  let stream: AbortController | undefined
  /**
   * O id do stream aberto (o primeiro evento) e a conversa que ele acompanha ao vivo. ⚖️ No MESMO stream, e não num
   * segundo: o navegador abre no máximo seis conexões por host, e duas permanentes por aba travavam tudo com três abas.
   */
  let streamId: string | undefined
  let followed: string | undefined
  let following = Promise.resolve()
  const turnListeners = new Set<(frame: TTurnFrame) => void>()
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
        archivedCount.value = result.archivedCount ?? 0
      } else {
        const result = await api<IConversationPage>('/conversations', { query: { limit: 500, ...useProjectsStore().query } })
        if (current !== generation) return
        all = result.sessions
        archivedCount.value = result.archivedCount ?? 0
        refilter()
      }
      if (view.value === 'archived') void loadArchived()
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

  /** As arquivadas, de uma vez só: costumam ser poucas, e não têm filtro nem paginação. */
  async function loadArchived(): Promise<void> {
    archivedLoading.value = true
    try {
      const result = await api<IConversationPage>('/conversations', { query: { archived: 1, limit: 500, ...useProjectsStore().query } })
      archivedItems.value = result.sessions
      archivedCount.value = Math.max(archivedCount.value, result.sessions.length)
      actionError.value = undefined
    } catch (failure) {
      actionError.value = failure instanceof Error ? failure.message : String(failure)
    } finally {
      archivedLoading.value = false
    }
  }

  function showView(next: 'inbox' | 'archived'): void {
    view.value = next
    if (next === 'archived') void loadArchived()
  }

  function fetchPage(number: number): Promise<IConversationPage> {
    const { q, agentId, classification } = filters.value
    return api<IConversationPage>('/conversations', {
      query: { scope: 'all', page: number, pageSize: PAGE_SIZE, q, agentId, classification, ...(everyone.value ? {} : { mine: 1 }), ...useProjectsStore().query },
    })
  }

  /** Sem paginação no servidor, o filtro é aplicado aqui sobre a lista inteira. */
  function refilter(): void {
    items.value = all.filter((item) => matchesFilters(item, filters.value))
    total.value = items.value.length
    const counts: Record<string, number> = {}
    for (const item of all) counts[item.agentId] = (counts[item.agentId] ?? 0) + 1
    facets.value = { agent: counts, classification: {}, provider: {} }
  }

  /** Liga ou desliga o "De todos" (só admin): relê a lista e troca a assinatura, para os eventos seguirem o mesmo recorte. */
  function setEveryone(on: boolean): Promise<void> {
    everyone.value = on
    subscribe(true)
    return load(true)
  }

  function setFilters(patch: Partial<IConversationFilters>, admin: boolean): Promise<void> | void {
    filters.value = { ...filters.value, ...patch }
    if (admin) return load(true)
    refilter()
  }

  function apply(event: TConversationEvent): void {
    const id = event.type === 'conversation.updated' ? event.session.id : event.sessionId
    const archivedNow = event.type === 'conversation.updated' && !!event.session.archivedAt
    const inArchived = archivedItems.value.some((item) => item.id === id)
    // Sai da caixa de entrada (apagada ou arquivada): a aba do agente perde uma.
    const gone = event.type === 'conversation.deleted' || archivedNow ? (items.value.find((item) => item.id === id) ?? all.find((item) => item.id === id)) : undefined
    const known = event.type === 'conversation.updated' && (items.value.some((item) => item.id === event.session.id) || all.some((item) => item.id === event.session.id))
    if (scope.value === 'mine') {
      all = applyEvent(all, event, { q: '', agentId: '', classification: '' }).items
    }

    // As arquivadas: a contagem só muda quando sei de onde a conversa veio (caixa de entrada ou lista de arquivadas).
    if (event.type === 'conversation.updated' && archivedNow) {
      if (known && !inArchived) archivedCount.value += 1
      const rest = archivedItems.value.filter((item) => item.id !== id)
      const at = rest.findIndex((item) => item.updatedAt < event.session.updatedAt)
      rest.splice(at === -1 ? rest.length : at, 0, event.session)
      archivedItems.value = rest
    } else if (inArchived) {
      archivedItems.value = archivedItems.value.filter((item) => item.id !== id)
      archivedCount.value = Math.max(archivedCount.value - 1, 0)
    }

    const result = applyEvent(items.value, event, filters.value)
    items.value = result.items
    if (result.added) total.value += 1
    // A aba do agente conta a conversa nova na hora; o resto das contagens acerta na próxima leitura.
    if (event.type === 'conversation.updated' && !known && !archivedNow && facets.value) {
      const agent = facets.value.agent
      facets.value = { ...facets.value, agent: { ...agent, [event.session.agentId]: (agent[event.session.agentId] ?? 0) + 1 } }
    }
    if (gone && facets.value) {
      const agent = { ...facets.value.agent, [gone.agentId]: Math.max((facets.value.agent[gone.agentId] ?? 1) - 1, 0) }
      if (!agent[gone.agentId]) delete agent[gone.agentId]
      facets.value = { ...facets.value, agent }
    }
    if (result.removed) total.value = Math.max(total.value - 1, 0)

    if (event.type === 'conversation.updated' && !archivedNow && event.session.id !== selectedId.value) unread.value = new Set([...unread.value, event.session.id])
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
          const body = await openStream('/conversations/events', { signal: controller.signal, query: { ...(admin && !everyone.value ? { mine: 1 } : {}), ...useProjectsStore().query } })
          live.value = true
          running.value = new Set()
          if (!first) {
            void load(admin)
            // O catálogo também: o aviso de mudança que caiu no meio não chegou.
            catalogResync()
          }
          first = false
          for await (const frame of readSse(body)) {
            if (controller.signal.aborted) return
            const event = frame.data as TStreamFrame
            if (event.type === 'stream.ready') {
              streamId = event.streamId
              if (followed) sendFollow()
            } else if (event.type.startsWith('turn.')) {
              const turn = event as TTurnFrame
              if (turn.sessionId === followed) for (const listener of turnListeners) listener(turn)
            } else if (event.type === 'catalog.changed') catalogChanged(event.changes)
            else if (event.type === 'conversation.running' || event.type === 'conversation.idle') markRunning(event.sessionId, event.type === 'conversation.running')
            else apply(event as TConversationEvent)
          }
        } catch {
          // Caiu ou foi abortado: o laço decide.
        }
        streamId = undefined
        live.value = false
        if (controller.signal.aborted) return
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS))
      }
    }
    void run(true)
  }

  function markRunning(id: string, on: boolean): void {
    if (running.value.has(id) === on) return
    const next = new Set(running.value)
    if (on) next.add(id)
    else next.delete(id)
    running.value = next
  }

  /** Acompanha ao vivo o turno de uma conversa (`undefined` para). Vale também depois de reconectar. */
  function follow(id: string | undefined): void {
    if (id === followed) return
    followed = id
    sendFollow()
  }

  /** Em fila: dois pedidos seguidos (sair de uma conversa, abrir outra) chegam na ordem. */
  function sendFollow(): void {
    const id = streamId
    if (!id) return
    following = following.then(() =>
      api(`/conversations/events/${encodeURIComponent(id)}/follow`, { method: 'PUT', body: { sessionId: followed ?? null } }).then(
        () => undefined,
        () => undefined,
      ),
    )
  }

  function onTurn(listener: (frame: TTurnFrame) => void): () => void {
    turnListeners.add(listener)
    return () => turnListeners.delete(listener)
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
    everyone.value = false
    facets.value = undefined
    archivedCount.value = 0
    archivedItems.value = []
    archivedLoading.value = false
    view.value = 'inbox'
    actionError.value = undefined
    page.value = 1
    scope.value = 'mine'
    loading.value = false
    error.value = undefined
    filters.value = { q: '', agentId: '', classification: '' }
    unread.value = new Set()
    running.value = new Set()
    followed = undefined
    selectedId.value = undefined
  }

  function find(id: string): IConversation | undefined {
    return items.value.find((item) => item.id === id) ?? all.find((item) => item.id === id) ?? archivedItems.value.find((item) => item.id === id)
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

  /**
   * Arquiva (ou desarquiva) na hora e confirma no servidor; se o servidor recusar, desfaz.
   *
   * ⚖️ Reusa `apply` nos dois sentidos, com a sessão como estava: lista, contagem e abas andam juntas, e o
   * evento que o servidor manda depois não conta de novo (a conversa já está no lugar certo).
   */
  async function archive(id: string, archived = true): Promise<void> {
    const before = find(id) ?? archivedItems.value.find((item) => item.id === id)
    if (!before) return
    const unreadBefore = unread.value.has(id)
    actionError.value = undefined
    apply({ type: 'conversation.updated', session: { ...before, archivedAt: archived ? new Date().toISOString() : undefined } })
    // Mexer na lista não é atividade nova.
    if (!unreadBefore && unread.value.has(id)) {
      const next = new Set(unread.value)
      next.delete(id)
      unread.value = next
    }
    try {
      await api(`/conversations/${encodeURIComponent(id)}/archive`, { method: 'PUT', body: { archived } })
    } catch (failure) {
      apply({ type: 'conversation.updated', session: before })
      actionError.value = `Não foi possível ${archived ? 'arquivar' : 'desarquivar'}: ${failure instanceof Error ? failure.message : String(failure)}`
      throw failure
    }
  }

  return {
    archivedCount,
    archivedItems,
    archivedLoading,
    view,
    actionError,
    loadArchived,
    showView,
    archive,
    items,
    total,
    facets,
    scope,
    everyone,
    setEveryone,
    loading,
    error,
    filters,
    unread,
    running,
    follow,
    onTurn,
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
