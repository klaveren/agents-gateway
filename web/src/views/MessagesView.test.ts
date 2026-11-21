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
const thread = { conversationId: 's1', agentId: 'zeus', title: 'Preciso do acesso', last: agentMessage, unread: 1, pending: 0, archived: false }

async function mount(id?: string, threads: unknown[] = [thread], fio: unknown[] = [agentMessage]) {
  const calls: Array<{ path: string; init?: Record<string, unknown> }> = []
  vi.mocked(api).mockImplementation((async (path: string, init?: Record<string, unknown>) => {
    calls.push({ path, init })
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

  it('guias Pendentes e Resolvidas: abre em Pendentes quando há alguma, e a outra guia mostra o resto', async () => {
    const done = { ...thread, conversationId: 's2', title: 'Já resolvido', pending: 0 }
    const { host } = await mount(undefined, [{ ...thread, pending: 1 }, done])
    const titles = () => [...host.querySelectorAll('[data-test="message-thread"]')].map((item) => item.textContent)
    expect(titles()).toHaveLength(1)
    expect(titles()[0]).toContain('Preciso do acesso')
    host.querySelector<HTMLButtonElement>('[data-test="tab-resolved"]')!.click()
    await nextTick()
    expect(titles()).toHaveLength(1)
    expect(titles()[0]).toContain('Já resolvido')
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

  describe('📌 um pedido por vez', () => {
    const pending = { ...agentMessage, id: 'm1', status: 'pending' }
    const answered = { ...agentMessage, id: 'm2', title: 'Outro pedido', level: 'urgent', status: 'answered', answeredAt: '2026-11-19T13:58:00Z', createdAt: '2026-11-19T10:05:00Z' }
    const resolved = { ...agentMessage, id: 'm3', title: 'Já tratado', status: 'resolved', createdAt: '2026-11-19T10:06:00Z' }
    const info = { ...agentMessage, id: 'm4', title: 'Aviso', level: 'info', createdAt: '2026-11-19T10:07:00Z' }
    const person = { id: 'p1', conversationId: 's1', agentId: 'zeus', from: 'person', body: 'Pode', level: 'info', createdAt: '2026-11-19T11:00:00Z', replyTo: 'm2' }
    const fio = [pending, answered, resolved, info, person]
    const withPending = { ...thread, pending: 1 }

    it('cada pedido mostra o seu estado; aviso comum não tem tag', async () => {
      const { host } = await mount('s1', [withPending], fio)
      expect(host.querySelector('[data-test="message-status-pending"]')?.textContent).toContain('Pendente')
      expect(host.querySelector('[data-test="message-status-answered"]')?.textContent).toMatch(/^\s*Respondido \S+/)
      expect(host.querySelector('[data-test="message-status-resolved"]')?.textContent).toContain('Resolvido')
      const cards = host.querySelectorAll('[data-test="message-agent"]')
      expect(cards[3].querySelector('[data-test^="message-status-"]')).toBeNull()
      expect(cards[3].querySelector('[data-test="message-reply-to"]')).toBeNull()
      expect(host.querySelector('[data-test="message-in-reply-to"]')?.textContent).toContain('em resposta a Outro pedido')
    })

    it('Responder escolhe o pedido: chip, placeholder, replyTo no envio e o alvo some depois', async () => {
      const { host, calls } = await mount('s1', [withPending], fio)
      host.querySelectorAll<HTMLButtonElement>('[data-test="message-reply-to"]')[0].click()
      await nextTick()
      expect(host.querySelector('[data-test="reply-target"]')?.textContent).toContain('Respondendo: Preciso do acesso')
      const box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
      expect(box.placeholder).toBe('Responder a este pedido…')
      box.value = 'Liberado.'
      box.dispatchEvent(new Event('input'))
      await nextTick()
      host.querySelector('form')!.dispatchEvent(new Event('submit'))
      await flush()
      expect(calls.find((call) => call.path === '/messages/s1/reply')?.init).toMatchObject({ body: { message: 'Liberado.', replyTo: 'm1' } })
      expect(host.querySelector('[data-test="reply-target"]')).toBeNull()
    })

    it('o × cancela o alvo e a resposta segue sem replyTo', async () => {
      const { host, calls } = await mount('s1', [withPending], fio)
      host.querySelectorAll<HTMLButtonElement>('[data-test="message-reply-to"]')[0].click()
      await nextTick()
      host.querySelector<HTMLButtonElement>('[data-test="reply-target-cancel"]')!.click()
      await nextTick()
      expect(host.querySelector('[data-test="reply-target"]')).toBeNull()
      const box = host.querySelector<HTMLTextAreaElement>('[data-test="message-reply"]')!
      box.value = 'Solta'
      box.dispatchEvent(new Event('input'))
      await nextTick()
      host.querySelector('form')!.dispatchEvent(new Event('submit'))
      await flush()
      expect(calls.find((call) => call.path === '/messages/s1/reply')?.init?.body).toEqual({ message: 'Solta' })
    })

    it('Marcar resolvido chama o endpoint e o cartão vira Resolvido; Reabrir volta a Pendente', async () => {
      const { host, calls } = await mount('s1', [withPending], fio)
      host.querySelector<HTMLButtonElement>('[data-test="message-resolve"]')!.click()
      await flush()
      expect(calls.find((call) => call.path === '/messages/s1/m1/status')?.init).toMatchObject({ method: 'PUT', body: { status: 'resolved' } })
      expect(host.querySelectorAll('[data-test="message-status-resolved"]')).toHaveLength(2)
      host.querySelectorAll<HTMLButtonElement>('[data-test="message-reopen"]')[0].click()
      await flush()
      expect(calls.filter((call) => call.path.endsWith('/status')).at(-1)?.init).toMatchObject({ body: { status: 'pending' } })
      expect(host.querySelectorAll('[data-test="message-status-pending"]')).toHaveLength(1)
    })

    it('contador de pendentes no cabeçalho e na lista; "Só pendentes" esconde o resto', async () => {
      const { host } = await mount('s1', [withPending], fio)
      expect(host.querySelector('[data-test="thread-pending"]')?.textContent).toContain('1 pendente')
      expect(host.querySelector('[data-test="thread-pending-count"]')?.textContent).toContain('1 pendente')
      host.querySelector<HTMLButtonElement>('[data-test="only-pending"]')!.click()
      await nextTick()
      expect(host.querySelectorAll('[data-test="message-agent"]')).toHaveLength(1)
      expect(host.querySelectorAll('[data-test="message-person"]')).toHaveLength(0)
    })

    it('sem pendentes não aparece contador', async () => {
      const { host } = await mount('s1', [{ ...thread, pending: 0 }], [answered])
      expect(host.querySelector('[data-test="thread-pending"]')).toBeNull()
      expect(host.querySelector('[data-test="thread-pending-count"]')).toBeNull()
    })
  })
})
