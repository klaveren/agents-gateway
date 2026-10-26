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
