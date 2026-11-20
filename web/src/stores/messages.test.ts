import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useMessagesStore } from './messages'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const settle = () => new Promise((resolve) => setTimeout(resolve))

function serve(unreadMessage: boolean) {
  const calls: string[] = []
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/messages') return { threads: [], unread: unreadMessage ? 1 : 0 }
    if (path === '/messages/s1') return { messages: [{ id: 'm1', from: 'agent', body: 'oi', ...(unreadMessage ? {} : { readAt: '2026-11-20T10:00:00Z' }) }] }
    if (path === '/messages/s1/read') return { unread: 0 }
    return {}
  }) as never)
  return calls
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(api).mockReset()
})

describe('mensagens: o fio aberto quando chega resposta', () => {
  it('🔔 com a janela fora de foco, a resposta fica não lida; vira lida quando a pessoa volta', async () => {
    setActivePinia(createPinia())
    const store = useMessagesStore()
    let calls = serve(false)
    await store.openThread('s1')
    calls = serve(true)
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    store.changed({ conversationId: 's1', unread: 1 })
    await settle()
    expect(calls).not.toContain('POST /messages/s1/read')
    expect(store.unread).toBe(1)

    focus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(calls).toContain('POST /messages/s1/read')
    expect(store.unread).toBe(0)
  })

  it('com a pessoa olhando, a resposta no fio aberto já entra lida', async () => {
    setActivePinia(createPinia())
    const store = useMessagesStore()
    const calls = serve(true)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    store.changed({ conversationId: 's1', unread: 1 })
    expect(calls).not.toContain('POST /messages/s1/read')
    await store.openThread('s1')
    store.changed({ conversationId: 's1', unread: 1 })
    await settle()
    expect(calls.filter((call) => call === 'POST /messages/s1/read').length).toBeGreaterThan(0)
  })
})
