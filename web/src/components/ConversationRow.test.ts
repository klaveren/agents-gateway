import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { openRowId } from '@/composables/useOpenRow'
import { api } from '@/lib/api'
import type { IConversation } from '@/lib/types'
import { useConversationsStore } from '@/stores/conversations'
import ConversationList from './ConversationList.vue'
import ConversationRow from './ConversationRow.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), openStream: vi.fn() }))

const conversation = (id: string, over: Partial<IConversation> = {}): IConversation => ({
  id,
  agentId: 'agente-a',
  provider: 'google',
  mode: 'chat',
  model: 'm',
  title: `Conversa ${id}`,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  turns: 1,
  usage: {},
  shared: false,
  ...over,
})

let app: App | undefined

vi.stubGlobal(
  'IntersectionObserver',
  class {
    observe() {}
    disconnect() {}
  },
)
let router: Router

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(component: object, props: Record<string, unknown> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  await router.push('/')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, props) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

/** jsdom não mede layout: a linha tem 400px de largura (as ações, 144px; metade = 72px; 70% = 280px). */
function sized(host: HTMLElement) {
  const row = host.querySelector<HTMLElement>('[data-testid=conversation-row]')!
  Object.defineProperty(row, 'offsetWidth', { value: 400 })
  return host.querySelector<HTMLElement>('[data-testid=conversation-slide]')!
}

function fire(el: Element, type: string, init: MouseEventInit & { deltaX?: number; deltaY?: number } = {}) {
  const event = type === 'wheel' ? new WheelEvent(type, { bubbles: true, cancelable: true, ...init }) : new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

async function drag(slide: Element, from: number, to: number) {
  fire(slide, 'pointerdown', { clientX: from, clientY: 10 })
  fire(slide, 'pointermove', { clientX: (from + to) / 2, clientY: 10 })
  fire(slide, 'pointermove', { clientX: to, clientY: 10 })
  fire(slide, 'pointerup', { clientX: to, clientY: 10 })
  await flush()
}

const offsetOf = (slide: HTMLElement) => slide.style.transform

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({})
  openRowId.value = undefined
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

const rowProps = (over: Record<string, unknown> = {}) => ({ conversation: conversation('a'), active: false, unread: false, showOwner: false, ...over })

describe('ConversationRow: deslizar', () => {
  it('passar da metade das ações deixa a linha aberta', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)

    await drag(slide, 300, 200)

    expect(offsetOf(slide)).toBe('translateX(-144px)')
    expect(openRowId.value).toBe('a')
  })

  it('um arrasto curto volta ao lugar', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)

    await drag(slide, 300, 260)

    expect(offsetOf(slide)).toBe('translateX(0px)')
    expect(openRowId.value).toBeUndefined()
  })

  it('deslizar até o fim arquiva na hora', async () => {
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a')]
    const slide = sized(host)

    await drag(slide, 390, 50)

    expect(api).toHaveBeenCalledWith('/conversations/a/archive', { method: 'PUT', body: { archived: true } })
    expect(store.items).toEqual([])
  })

  it('abrir outra linha fecha a que estava aberta', async () => {
    const host = await mount({ render: () => h('div', [h(ConversationRow, rowProps()), h(ConversationRow, rowProps({ conversation: conversation('b') }))]) })
    const [one, two] = [...host.querySelectorAll<HTMLElement>('[data-testid=conversation-slide]')]

    await drag(one!, 300, 200)
    expect(openRowId.value).toBe('a')
    await drag(two!, 300, 200)

    expect(openRowId.value).toBe('b')
    expect(offsetOf(one!)).toBe('translateX(0px)')
  })

  it('o trackpad (wheel horizontal) abre ao assentar', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)
    vi.useFakeTimers()
    try {
      const event = fire(slide, 'wheel', { deltaX: 60, deltaY: 1 })
      fire(slide, 'wheel', { deltaX: 60, deltaY: 1 })
      expect(event.defaultPrevented).toBe(true)
      vi.advanceTimersByTime(200)
      await nextTick()

      expect(offsetOf(slide)).toBe('translateX(-144px)')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a rolagem vertical não é com a linha', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)

    const event = fire(slide, 'wheel', { deltaX: 2, deltaY: 40 })

    expect(event.defaultPrevented).toBe(false)
    expect(offsetOf(slide)).toBe('translateX(0px)')
  })
})

describe('ConversationRow: clique', () => {
  it('fechada, o clique abre a conversa', async () => {
    const host = await mount(ConversationRow, rowProps())
    sized(host)

    host.querySelector<HTMLElement>('a')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/c/a')
  })

  it('aberta, o clique só fecha — não navega', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)
    await drag(slide, 300, 200)
    await new Promise((resolve) => setTimeout(resolve, 5))

    host.querySelector<HTMLElement>('a')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(offsetOf(slide)).toBe('translateX(0px)')
  })

  it('o clique que vem logo depois de arrastar não navega', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)
    fire(slide, 'pointerdown', { clientX: 300, clientY: 10 })
    fire(slide, 'pointermove', { clientX: 280, clientY: 10 })
    fire(slide, 'pointerup', { clientX: 280, clientY: 10 })

    host.querySelector<HTMLElement>('a')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('um toque parado (sem passar do limite) ainda é clique', async () => {
    const host = await mount(ConversationRow, rowProps())
    const slide = sized(host)
    fire(slide, 'pointerdown', { clientX: 300, clientY: 10 })
    fire(slide, 'pointermove', { clientX: 297, clientY: 11 })
    fire(slide, 'pointerup', { clientX: 297, clientY: 11 })

    host.querySelector<HTMLElement>('a')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/c/a')
  })
})

describe('ConversationRow: ações', () => {
  it('Arquivar chama o PUT e tira a linha da lista', async () => {
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a'), conversation('b')]
    store.archivedCount = 0

    host.querySelector<HTMLElement>('[data-action=archive]')!.click()
    await flush()

    expect(api).toHaveBeenCalledWith('/conversations/a/archive', { method: 'PUT', body: { archived: true } })
    expect(store.items.map((item) => item.id)).toEqual(['b'])
    expect(store.archivedCount).toBe(1)
  })

  it('se o servidor recusar, a linha volta e a mensagem aparece', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('sem permissão'))
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a')]

    host.querySelector<HTMLElement>('[data-action=archive]')!.click()
    await flush()

    expect(store.items.map((item) => item.id)).toEqual(['a'])
    expect(store.archivedCount).toBe(0)
    expect(store.actionError).toContain('sem permissão')
  })

  it('Excluir pergunta antes; só confirmar chama o DELETE', async () => {
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a')]

    host.querySelector<HTMLElement>('[data-action=delete]')!.click()
    await flush()
    expect(document.body.textContent).toContain('Excluir esta conversa?')
    expect(api).not.toHaveBeenCalled()

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((button) => button.textContent?.trim() === 'Excluir')!
    confirm.click()
    await flush()

    expect(api).toHaveBeenCalledWith('/conversations/a', { method: 'DELETE' })
    expect(store.items).toEqual([])
  })

  it('cancelar não apaga nada', async () => {
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a')]

    host.querySelector<HTMLElement>('[data-action=delete]')!.click()
    await flush()
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button')].find((button) => button.textContent?.trim() === 'Cancelar')!
    cancel.click()
    await flush()

    expect(api).not.toHaveBeenCalled()
    expect(store.items).toHaveLength(1)
  })

  it('o menu ⋯ tem as mesmas duas ações', async () => {
    const host = await mount(ConversationRow, rowProps())
    const store = useConversationsStore()
    store.items = [conversation('a')]

    host.querySelector<HTMLElement>('[data-action=menu]')!.click()
    await flush()
    expect(host.querySelector('[data-action=menu-delete]')).not.toBeNull()
    host.querySelector<HTMLElement>('[data-action=menu-archive]')!.click()
    await flush()

    expect(api).toHaveBeenCalledWith('/conversations/a/archive', { method: 'PUT', body: { archived: true } })
  })

  it('nas arquivadas, o botão é Desarquivar e volta para a caixa de entrada', async () => {
    const archived = conversation('z', { archivedAt: '2026-11-02T10:00:00Z' })
    const host = await mount(ConversationRow, rowProps({ conversation: archived, archived: true }))
    const store = useConversationsStore()
    store.archivedItems = [archived]
    store.archivedCount = 1

    expect(host.querySelector('[data-action=archive]')!.textContent).toContain('Desarquivar')
    host.querySelector<HTMLElement>('[data-action=archive]')!.click()
    await flush()

    expect(api).toHaveBeenCalledWith('/conversations/z/archive', { method: 'PUT', body: { archived: false } })
    expect(store.archivedItems).toEqual([])
    expect(store.archivedCount).toBe(0)
    expect(store.items.map((item) => item.id)).toEqual(['z'])
  })
})

describe('ConversationList: Arquivadas', () => {
  it('a entrada só aparece com arquivadas, mostra a contagem e abre a lista delas', async () => {
    vi.mocked(api).mockImplementation(async (path: string, options?: { query?: Record<string, unknown> }) => {
      if (path === '/conversations' && options?.query?.archived) return { sessions: [conversation('z', { archivedAt: '2026-11-02T10:00:00Z', title: 'Velha' })] }
      return { sessions: [conversation('a')], archivedCount: 3 }
    })
    const host = await mount(ConversationList)
    const store = useConversationsStore()

    expect(host.querySelector('[data-testid=archived-entry]')).toBeNull()
    await store.load(false)
    await flush()
    const entry = host.querySelector<HTMLElement>('[data-testid=archived-entry]')!
    expect(entry.textContent).toContain('Arquivadas')
    expect(entry.textContent).toContain('3')

    entry.click()
    await flush()
    expect(host.textContent).toContain('Velha')
    expect(host.textContent).not.toContain('Conversa a')
    expect(host.querySelector('[data-action=archive]')!.textContent).toContain('Desarquivar')

    host.querySelector<HTMLElement>('[data-testid=archived-back]')!.click()
    await flush()
    expect(host.textContent).toContain('Conversa a')
  })

  it('sem arquivadas, a entrada não aparece', async () => {
    vi.mocked(api).mockResolvedValue({ sessions: [conversation('a')], archivedCount: 0 })
    const host = await mount(ConversationList)
    await useConversationsStore().load(false)
    await flush()

    expect(host.querySelector('[data-testid=archived-entry]')).toBeNull()
  })
})
