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
const thread = { id: 's1', conversationId: 's1', agentId: 'zeus', title: 'Preciso do acesso', last: agentMessage, unread: 1, pending: 0, archived: false }

async function mount(id?: string, threads: unknown[] = [thread], fio: unknown[] = [agentMessage], extra: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = []
  vi.mocked(api).mockImplementation((async (path: string, init?: Record<string, unknown>) => {
    calls.push({ path, init })
    if (path in extra) return extra[path]
    if (path === '/agents') return [{ id: 'zeus', name: 'Zeus', providers: [] }]
    if (path === '/messages') return { threads, unread: 1, pending: 2 }
    if (path.endsWith('/archive')) return { unread: 1 }
    if (path === '/messages/s1') return { messages: fio }
    if (path.endsWith('/status')) return { status: (init?.body as { status: string }).status, pending: 1 }
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
  return { host, calls, router }
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

  it('✍️ a resposta em escrita sobrevive à troca de tela; enviar limpa', async () => {
    localStorage.clear()
    let { host } = await mount('s1')
    let box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
    box.value = 'Metade da respo'
    box.dispatchEvent(new Event('input'))
    await flush()
    app?.unmount()
    ;({ host } = await mount('s1'))
    box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
    expect(box.value).toBe('Metade da respo')
    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(localStorage.getItem('gw-draft:message:s1')).toBeNull()
  })

  it('🗂️ arquiva direto da lista, sem abrir o fio', async () => {
    const { host, calls } = await mount()
    host.querySelector<HTMLButtonElement>('[data-test="message-thread-archive"]')!.click()
    await flush()
    expect(calls.find((call) => call.path === '/messages/s1/archive')?.init).toMatchObject({ method: 'PUT', body: { archived: true } })
    expect(host.querySelectorAll('[data-test="message-thread"]')).toHaveLength(0)
  })

  it('"Arquivar lidas" leva só as lidas; a não lida fica', async () => {
    const read = { ...thread, id: 's2', conversationId: 's2', unread: 0, last: { ...agentMessage, id: 'm2', conversationId: 's2' } }
    const { host, calls } = await mount(undefined, [thread, read])
    host.querySelector<HTMLButtonElement>('[data-test="archive-read"]')!.click()
    await flush()
    expect(calls.filter((call) => call.path.endsWith('/archive')).map((call) => call.path)).toEqual(['/messages/s2/archive'])
  })

  it('na tela estreita o fio aberto também arquiva (pela barra de cima)', async () => {
    const { host } = await mount('s1')
    expect(host.querySelector('[data-test="message-archive-mobile"]')).not.toBeNull()
  })

  describe('📌 cada pedido é um item', () => {
    const pending = { ...agentMessage, id: 'm1', status: 'pending' }
    const person = { id: 'p1', conversationId: 's1', agentId: 'zeus', from: 'person', body: 'Pode', level: 'info', createdAt: '2026-11-19T11:00:00Z', replyTo: 'm1' }
    const back = { ...agentMessage, id: 'm9', title: undefined, body: 'Subi.', level: 'info', turn: undefined, replyTo: 'm1', createdAt: '2026-11-19T11:05:00Z' }
    const info = { ...agentMessage, id: 'm4', title: 'Aviso', level: 'info', createdAt: '2026-11-19T10:07:00Z' }
    const item = { ...thread, id: 'm1', requestId: 'm1', pending: 1 }

    const served = {
      '/messages/m1': { messages: [pending, person, back] },
      '/messages/m1/reply': { queued: false },
      '/messages/m1/m1/status': { status: 'resolved', pending: 0 },
      '/conversations/s1/turns': { turns: [] },
    }

    it('o item do pedido: o pedido, a resposta e o retorno do agente; o contexto vai para a conversa de origem', async () => {
      const { host, calls } = await mount('m1', [item], [], served)
      expect(host.querySelectorAll('[data-test="message-agent"]')).toHaveLength(2)
      expect(host.querySelectorAll('[data-test="message-person"]')).toHaveLength(1)
      expect(host.querySelector('[data-test="message-status-pending"]')?.textContent).toContain('Pendente')
      expect(host.querySelector('[data-test="thread-pending"]')?.textContent).toContain('1 pendente')
      expect(host.querySelector('[data-test="message-thread"]')?.getAttribute('href')).toBe('/messages/m1')
      expect(calls.some((call) => call.path === '/conversations/s1/turns')).toBe(true)
      expect(host.querySelector('[data-test="message-open-turn"]')?.getAttribute('href')).toBe('/c/s1?turn=4')
    })

    it('Responder vai pelo id do pedido; Marcar resolvido muda o estado dele e tira a contagem', async () => {
      const { host, calls } = await mount('m1', [item], [], served)
      const box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
      box.value = 'Liberado.'
      box.dispatchEvent(new Event('input'))
      await nextTick()
      host.querySelector('form')!.dispatchEvent(new Event('submit'))
      await flush()
      expect(calls.find((call) => call.path === '/messages/m1/reply')?.init).toMatchObject({ method: 'POST', body: { message: 'Liberado.' } })
      host.querySelector<HTMLButtonElement>('[data-test="message-resolve"]')!.click()
      await flush()
      expect(calls.find((call) => call.path === '/messages/m1/m1/status')?.init).toMatchObject({ method: 'PUT', body: { status: 'resolved' } })
      expect(host.querySelector('[data-test="message-status-resolved"]')).not.toBeNull()
      expect(host.querySelector('[data-test="thread-pending"]')).toBeNull()
    })

    it('o item da conversa mostra só os avisos (o pedido fica no item dele)', async () => {
      const { host } = await mount('s1', [thread, item], [pending, info])
      const cards = [...host.querySelectorAll('[data-test="message-agent"]')]
      expect(cards).toHaveLength(1)
      expect(cards[0].textContent).toContain('Aviso')
    })

    it('o link antigo com o id da conversa leva ao pedido dela', async () => {
      const { router } = await mount('s1', [item], [pending], served)
      await flush()
      expect(router.currentRoute.value.path).toBe('/messages/m1')
    })
  })
})

describe('Mensagens: item de projeto conectado', () => {
  const remote = { ...thread, id: 'm_r1', conversationId: 'c_origem', origin: { projectId: 'logiccus', url: 'http://servidor:3000/v1' } }
  const remoteMessage = { ...agentMessage, id: 'm_r1', conversationId: 'c_origem', status: 'pending' }

  it('não pede o contexto à conversa local e o link abre a conversa na origem, em outra aba', async () => {
    const { host, calls } = await mount('m_r1', [remote], [remoteMessage], {
      '/messages/m_r1': { messages: [remoteMessage] },
      '/messages/m_r1/read': { unread: 0 },
    })
    expect(calls.some((call) => call.path.endsWith('/turns'))).toBe(false)
    expect(host.querySelector('[data-test="message-context"]')).toBeNull()
    const link = host.querySelector('[data-test="message-open-origin"]')
    expect(link?.getAttribute('href')).toBe('http://servidor:3000/c/c_origem?turn=4')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(host.querySelector('[data-test="message-open-turn"]')).toBeNull()
  })

  it('resolver e responder usam as mesmas rotas daqui', async () => {
    const { calls } = await mount('m_r1', [remote], [remoteMessage], {
      '/messages/m_r1': { messages: [remoteMessage] },
      '/messages/m_r1/read': { unread: 0 },
      '/messages/m_r1/reply': { queued: false },
    })
    const store = (await import('@/stores/messages')).useMessagesStore()
    await store.reply('m_r1', 'Pode seguir')
    await store.setStatus('m_r1', 'm_r1', 'resolved')
    expect(calls.map((call) => call.path)).toEqual(expect.arrayContaining(['/messages/m_r1/reply', '/messages/m_r1/m_r1/status']))
  })
})
