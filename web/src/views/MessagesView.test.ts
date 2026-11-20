import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import MessagesView from './MessagesView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const agentMessage = {
  id: 'm1',
  conversationId: 's1',
  agentId: 'zeus',
  from: 'agent',
  title: 'Preciso do acesso',
  body: 'Libera o **banco**?',
  level: 'attention',
  turn: 4,
  createdAt: '2026-11-19T10:00:00Z',
}
const thread = { conversationId: 's1', agentId: 'zeus', title: 'Preciso do acesso', last: agentMessage, unread: 1, archived: false }

async function mount(id?: string, threads: unknown[] = [thread]) {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = []
  vi.mocked(api).mockImplementation((async (path: string, init?: Record<string, unknown>) => {
    calls.push({ path, init })
    if (path === '/agents') return [{ id: 'zeus', name: 'Zeus', providers: [] }]
    if (path === '/messages') return { threads, unread: 1 }
    if (path.endsWith('/archive')) return { unread: 1 }
    if (path === '/messages/s1') return { messages: [agentMessage] }
    if (path === '/messages/s1/read') return { unread: 0 }
    if (path === '/messages/s1/reply') return { queued: false }
    if (path === '/conversations/s1/turns') return { turns: [{ index: 3, request: 'Sobe a migração', text: 'Preciso de acesso ao banco.' }] }
    return {}
  }) as never)
  setActivePinia(createPinia())
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await router.push(id ? `/messages/${id}` : '/messages')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(MessagesView, { id }) })
  app.use(router).mount(host)
  await flush()
  return { host, calls }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('Mensagens', () => {
  it('lista os fios com o assunto, o trecho e as não lidas', async () => {
    const { host } = await mount()
    const item = host.querySelector('[data-test="message-thread"]')
    expect(item?.textContent).toContain('Preciso do acesso')
    expect(item?.textContent).toContain('Libera o **banco**?')
    expect(item?.getAttribute('href')).toBe('/messages/s1')
  })

  it('o fio aberto: marca como lida, mostra o contexto até o turno e o link que abre a conversa nele', async () => {
    const { host, calls } = await mount('s1')
    expect(calls.some((call) => call.path === '/messages/s1/read')).toBe(true)
    const turns = calls.find((call) => call.path === '/conversations/s1/turns')
    expect(turns?.init).toMatchObject({ query: { before: 5 } })
    expect(host.querySelector('[data-test="message-context"]')?.textContent).toContain('Sobe a migração')
    expect(host.querySelector('[data-test="message-open-turn"]')?.getAttribute('href')).toBe('/c/s1?turn=4')
    expect(host.querySelector('[data-test="message-agent"] .prose-agent strong')?.textContent).toBe('banco')
  })

  it('responder manda para a conversa e avisa que a resposta do agente volta para cá', async () => {
    const { host, calls } = await mount('s1')
    const box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
    box.value = 'Liberado.'
    box.dispatchEvent(new Event('input'))
    await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(calls.find((call) => call.path === '/messages/s1/reply')?.init).toMatchObject({ method: 'POST', body: { message: 'Liberado.' } })
    expect(host.textContent).toContain('A resposta do agente aparece aqui')
  })

  it('🗂️ arquiva direto da lista, sem abrir o fio', async () => {
    const { host, calls } = await mount()
    host.querySelector<HTMLButtonElement>('[data-test="message-thread-archive"]')!.click()
    await flush()
    expect(calls.find((call) => call.path === '/messages/s1/archive')?.init).toMatchObject({ method: 'PUT', body: { archived: true } })
    expect(host.querySelectorAll('[data-test="message-thread"]')).toHaveLength(0)
  })

  it('"Arquivar lidas" leva só as lidas; a não lida fica', async () => {
    const read = { ...thread, conversationId: 's2', unread: 0, last: { ...agentMessage, id: 'm2', conversationId: 's2' } }
    const { host, calls } = await mount(undefined, [thread, read])
    host.querySelector<HTMLButtonElement>('[data-test="archive-read"]')!.click()
    await flush()
    expect(calls.filter((call) => call.path.endsWith('/archive')).map((call) => call.path)).toEqual(['/messages/s2/archive'])
  })

  it('na tela estreita o fio aberto também arquiva (pela barra de cima)', async () => {
    const { host } = await mount('s1')
    expect(host.querySelector('[data-test="message-archive-mobile"]')).not.toBeNull()
  })
})
