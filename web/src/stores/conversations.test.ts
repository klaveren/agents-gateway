import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { IConversation, IConversationPage } from '@/lib/types'
import { applyEvent, useConversationsStore, type IConversationFilters } from './conversations'

vi.mock('@/lib/api', () => ({ api: vi.fn(), openStream: vi.fn() }))

const conversation = (id: string, updatedAt: string, over: Partial<IConversation> = {}): IConversation => ({
  id,
  agentId: 'agente-a',
  provider: 'google',
  mode: 'chat',
  model: 'gemini-3.7-flash',
  createdAt: updatedAt,
  updatedAt,
  turns: 1,
  usage: {},
  shared: false,
  ...over,
})

const none: IConversationFilters = { q: '', agentId: '', classification: '' }

describe('applyEvent', () => {
  const list = [conversation('b', '2026-10-22T10:02:00Z'), conversation('a', '2026-10-22T10:01:00Z')]

  it('a conversa atualizada sobe para o topo, sem duplicar', () => {
    const result = applyEvent(list, { type: 'conversation.updated', session: conversation('a', '2026-10-22T10:05:00Z') }, none)

    expect(result.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(result.added).toBe(false)
  })

  it('a nova entra e conta como adicionada', () => {
    const result = applyEvent(list, { type: 'conversation.updated', session: conversation('c', '2026-10-22T10:09:00Z') }, none)

    expect(result.items.map((item) => item.id)).toEqual(['c', 'b', 'a'])
    expect(result.added).toBe(true)
  })

  it('a que não casa com o filtro aberto sai da lista (ou nem entra)', () => {
    const filters = { ...none, agentId: 'agente-b' }
    const result = applyEvent(list, { type: 'conversation.updated', session: conversation('a', '2026-10-22T10:05:00Z') }, filters)

    expect(result.items.map((item) => item.id)).toEqual(['b'])
    expect(result.removed).toBe(true)
  })

  it('a apagada sai', () => {
    expect(applyEvent(list, { type: 'conversation.deleted', sessionId: 'b' }, none).items.map((item) => item.id)).toEqual(['a'])
  })

  it('a busca casa título e e-mail do dono, sem diferenciar caixa', () => {
    const owned = conversation('d', '2026-10-22T10:09:00Z', { title: 'Pedido', metadata: { owner: { email: 'Ana@X.test' } } })

    expect(applyEvent([], { type: 'conversation.updated', session: owned }, { ...none, q: 'ana@' }).added).toBe(true)
    expect(applyEvent([], { type: 'conversation.updated', session: owned }, { ...none, q: 'pedi' }).added).toBe(true)
    expect(applyEvent([], { type: 'conversation.updated', session: owned }, { ...none, q: 'bia' }).added).toBe(false)
  })

  it('a busca acha pelo id (gw_…)', () => {
    const cited = conversation('gw_01M6P3NGTK9PFHYSET4GPWHDK4', '2026-10-22T10:09:00Z', { title: 'Migração' })
    expect(applyEvent([], { type: 'conversation.updated', session: cited }, { ...none, q: 'gw_01m6p3ng' }).added).toBe(true)
  })

  it('⛔ a delegada não entra na caixa de entrada (aparece dentro da conversa que a originou)', () => {
    const child = conversation('filha', '2026-10-22T10:09:00Z', { metadata: { delegatedBy: 'mae' } })
    expect(applyEvent([], { type: 'conversation.updated', session: child }, none).added).toBe(false)
  })
})

describe('store: a caixa do admin é dele; "De todos" liga o monitor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('por padrão pede só as suas (mine=1); com De todos, sem', async () => {
    const store = useConversationsStore()
    vi.mocked(api).mockResolvedValue({ sessions: [], total: 0 } as never)
    await store.load(true)
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]).toMatchObject({ query: { scope: 'all', mine: 1 } })

    await store.setEveryone(true)
    const query = (vi.mocked(api).mock.calls.at(-1)?.[1] as { query: Record<string, unknown> }).query
    expect(query.scope).toBe('all')
    expect(query.mine).toBeUndefined()
    store.unsubscribe()
  })
})

describe('store: respostas obsoletas', () => {
  const page = (ids: string[], total: number): IConversationPage => ({ sessions: ids.map((id) => conversation(id, '2026-10-22T10:00:00Z')), total })
  const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => (resolve = done))
    return { promise, resolve }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('loadMore de um filtro anterior não anexa à lista do filtro atual', async () => {
    const store = useConversationsStore()
    vi.mocked(api).mockResolvedValueOnce(page(['a1', 'a2'], 5))
    await store.load(true)

    const old = deferred<IConversationPage>()
    vi.mocked(api).mockReturnValueOnce(old.promise as never)
    const more = store.loadMore()

    vi.mocked(api).mockResolvedValueOnce(page(['b1'], 1))
    await store.setFilters({ agentId: 'other' }, true)
    old.resolve(page(['a3', 'a4'], 5))
    await more

    expect(store.items.map((item) => item.id)).toEqual(['b1'])
    expect(store.total).toBe(1)
    expect(store.loading).toBe(false)
  })

  it('loadMore ainda anexa quando nada mudou', async () => {
    const store = useConversationsStore()
    vi.mocked(api).mockResolvedValueOnce(page(['a1', 'a2'], 3))
    await store.load(true)
    vi.mocked(api).mockResolvedValueOnce(page(['a3'], 3))
    await store.loadMore()

    expect(store.items.map((item) => item.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('o load antigo não sobrescreve o mais novo', async () => {
    const store = useConversationsStore()
    const slow = deferred<IConversationPage>()
    vi.mocked(api).mockReturnValueOnce(slow.promise as never)
    const first = store.load(true)
    vi.mocked(api).mockResolvedValueOnce(page(['novo'], 1))
    await store.load(true)
    slow.resolve(page(['velho'], 1))
    await first

    expect(store.items.map((item) => item.id)).toEqual(['novo'])
  })

  it('reset zera lista, contadores e seleção, e invalida respostas em voo', async () => {
    const store = useConversationsStore()
    vi.mocked(api).mockResolvedValueOnce(page(['a1'], 4))
    await store.load(true)
    store.apply({ type: 'conversation.updated', session: conversation('z', '2026-10-22T11:00:00Z') })
    store.select('a1')
    expect(store.unread.size).toBe(1)

    const late = deferred<IConversationPage>()
    vi.mocked(api).mockReturnValueOnce(late.promise as never)
    const more = store.loadMore()
    store.reset()
    late.resolve(page(['velho'], 4))
    await more

    expect(store.items).toEqual([])
    expect(store.total).toBe(0)
    expect(store.unread.size).toBe(0)
    expect(store.selectedId).toBeUndefined()
    expect(store.live).toBe(false)
    expect(store.loading).toBe(false)
  })
})

describe('arquivadas', () => {
  const archivedAt = '2026-11-02T10:00:00Z'

  it('applyEvent: a arquivada sai da caixa de entrada; a desarquivada volta', () => {
    const list = [conversation('a', '2026-10-22T10:01:00Z')]

    const out = applyEvent(list, { type: 'conversation.updated', session: conversation('a', '2026-10-22T10:05:00Z', { archivedAt }) }, none)
    expect(out.items).toEqual([])
    expect(out.removed).toBe(true)

    const back = applyEvent(out.items, { type: 'conversation.updated', session: conversation('a', '2026-10-22T10:06:00Z') }, none)
    expect(back.items.map((item) => item.id)).toEqual(['a'])
    expect(back.added).toBe(true)
  })

  it('o evento move a sessão para a lista de arquivadas e acerta a contagem', async () => {
    vi.mocked(api).mockResolvedValueOnce({ sessions: [conversation('a', '2026-10-22T10:01:00Z'), conversation('b', '2026-10-22T10:02:00Z')], archivedCount: 2 })
    const store = useConversationsStore()
    await store.load(false)
    expect(store.archivedCount).toBe(2)

    store.apply({ type: 'conversation.updated', session: conversation('a', '2026-10-22T10:05:00Z', { archivedAt }) })
    expect(store.items.map((item) => item.id)).toEqual(['b'])
    expect(store.archivedItems.map((item) => item.id)).toEqual(['a'])
    expect(store.archivedCount).toBe(3)
    expect(store.unread.has('a')).toBe(false)

    // O mesmo evento de novo (o do servidor, depois do otimista) não conta duas vezes.
    store.apply({ type: 'conversation.updated', session: conversation('a', '2026-10-22T10:05:00Z', { archivedAt }) })
    expect(store.archivedCount).toBe(3)

    store.apply({ type: 'conversation.updated', session: conversation('a', '2026-10-22T10:07:00Z') })
    expect(store.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(store.archivedItems).toEqual([])
    expect(store.archivedCount).toBe(2)
  })

  it('apagar uma arquivada baixa a contagem', () => {
    const store = useConversationsStore()
    store.archivedItems = [conversation('z', '2026-10-22T10:01:00Z', { archivedAt })]
    store.archivedCount = 1

    store.apply({ type: 'conversation.deleted', sessionId: 'z' })

    expect(store.archivedItems).toEqual([])
    expect(store.archivedCount).toBe(0)
  })
})
