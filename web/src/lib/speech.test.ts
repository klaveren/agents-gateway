import { describe, expect, it } from 'vitest'
import type { IPersonMessage } from '@/stores/messages'
import { levelAtLeast, speakable } from './speech'

const message = (id: string, extra: Partial<IPersonMessage> = {}): IPersonMessage => ({
  id,
  conversationId: 'c1',
  agentId: 'zeus',
  from: 'agent',
  body: 'oi',
  level: 'info',
  createdAt: '2026-11-20T12:00:10Z',
  ...extra,
})

describe('speakable', () => {
  const since = Date.parse('2026-11-20T12:00:00Z')

  it('só as do agente, de depois da abertura, no nível pedido e ainda não vistas, da mais antiga para a mais nova', () => {
    const list = [
      message('b', { createdAt: '2026-11-20T12:00:30Z' }),
      message('a', { createdAt: '2026-11-20T12:00:10Z' }),
      message('mine', { from: 'person' }),
      message('old', { createdAt: '2026-11-20T11:00:00Z' }),
      message('seen'),
      message('low', { level: 'info' }),
    ]
    const result = speakable(list, { since, minLevel: 'info', seen: new Set(['seen']) })
    expect(result.map((item) => item.id)).toEqual(['a', 'low', 'b'])
    expect(speakable(list, { since, minLevel: 'attention', seen: new Set() })).toEqual([])
    expect(speakable([message('u', { level: 'urgent' }), message('t', { level: 'attention' })], { since, minLevel: 'urgent', seen: new Set() }).map((item) => item.id)).toEqual(['u'])
  })

  it('ordem dos níveis', () => {
    expect(levelAtLeast('urgent', 'attention')).toBe(true)
    expect(levelAtLeast('info', 'attention')).toBe(false)
  })
})
