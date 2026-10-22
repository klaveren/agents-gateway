import { describe, expect, it } from 'vitest'
import type { IConversation } from '@/lib/types'
import { applyEvent, type IConversationFilters } from './conversations'

const conversation = (id: string, updatedAt: string, over: Partial<IConversation> = {}): IConversation => ({
  id,
  agentId: 'researcher-agent',
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
    const filters = { ...none, agentId: 'sysops-agent' }
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
