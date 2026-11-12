import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import type { IConversation } from '@/lib/types'
import { useConversationsStore } from '@/stores/conversations'
import DelegationsPanel from './DelegationsPanel.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn().mockResolvedValue([]),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

let app: App | undefined
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
})

const child = (id: string, agentId: string, total: number) => ({ id, agentId, title: `tarefa ${id}`, usage: { totalTokens: total } }) as unknown as IConversation

async function mount(items: IConversation[], running: string[] = []) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useConversationsStore().running = new Set(running)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp(DelegationsPanel, { items, showCost: false })
  app.use(pinia).use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { template: '<div />' } }] }))
  app.mount(host)
  await nextTick()
  return host
}

describe('DelegationsPanel', () => {
  it('recolhido: a contagem e quem ainda trabalha; aberto, uma linha por conversa filha', async () => {
    const host = await mount([child('a', 'agent-sre', 1000), child('b', 'agent-god', 2000)], ['b'])
    const toggle = host.querySelector<HTMLButtonElement>('[data-test="delegations-toggle"]')!
    expect(toggle.textContent).toContain('1 de 2')
    expect(toggle.textContent).not.toContain('concluídas')
    expect(toggle.textContent).toContain('trabalhando')
    expect(host.querySelector('[data-child]')).toBeNull()
    toggle.click()
    await nextTick()
    expect(host.querySelectorAll('[data-child]')).toHaveLength(2)
  })

  it('a ordem é a da última interação: a mais recente em cima, e a que começa a rodar sobe na hora', async () => {
    const at = (id: string, agentId: string, updatedAt: string) => ({ ...child(id, agentId, 0), updatedAt }) as IConversation
    const host = await mount([at('a', 'agent-sre', '2026-11-11T10:00:00.000Z'), at('b', 'agent-god', '2026-11-11T12:00:00.000Z'), at('c', 'agent-qa', '2026-11-11T11:00:00.000Z')])
    host.querySelector<HTMLButtonElement>('[data-test="delegations-toggle"]')!.click()
    await nextTick()
    const order = () => [...host.querySelectorAll('[data-child]')].map((link) => link.getAttribute('data-child'))
    expect(order()).toEqual(['b', 'c', 'a'])

    useConversationsStore().running = new Set(['a'])
    await nextTick()
    await nextTick()
    expect(order()).toEqual(['a', 'b', 'c'])
  })

  it('todas acabaram: concluídas', async () => {
    const host = await mount([child('a', 'agent-sre', 1000)])
    expect(host.querySelector('[data-test="delegations-toggle"]')!.textContent).toContain('1 de 1 · concluídas')
  })
})
