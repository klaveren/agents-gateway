import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { openRowId } from '@/composables/useOpenRow'
import type { IPersonThread } from '@/stores/messages'
import MessageThreadRow from './MessageThreadRow.vue'

const thread = (id: string, over: Partial<IPersonThread> = {}): IPersonThread => ({
  id,
  conversationId: id,
  agentId: 'agente-a',
  title: `Fio ${id}`,
  last: { id: 'm1', from: 'agent', level: 'info', body: 'Oi', createdAt: '2026-11-01T10:00:00Z' } as IPersonThread['last'],
  unread: 0,
  pending: 0,
  archived: false,
  ...over,
})

let app: App | undefined
let router: Router
let archived: string[] = []

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(props: Record<string, unknown> = {}, ids = ['a']) {
  const pinia = createPinia()
  setActivePinia(pinia)
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  await router.push('/')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({
    render: () =>
      h(
        'div',
        ids.map((id) => h(MessageThreadRow, { thread: thread(id), active: false, name: 'Agente A', provider: 'google', onArchive: (value: string) => archived.push(value), ...props })),
      ),
  })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

/** jsdom não mede layout: a linha tem 400px de largura (a ação, 72px; metade = 36px; 70% = 280px). */
function sized(host: HTMLElement) {
  for (const row of host.querySelectorAll<HTMLElement>('[data-testid=thread-row]')) Object.defineProperty(row, 'offsetWidth', { value: 400 })
  return host.querySelector<HTMLElement>('[data-testid=thread-slide]')!
}

function fire(el: Element, type: string, init: MouseEventInit & { deltaX?: number; deltaY?: number } = {}) {
  const event = type === 'wheel' ? new WheelEvent(type, { bubbles: true, cancelable: true, ...init }) : new MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

async function drag(slide: Element, from: number, to: number, y = 10) {
  fire(slide, 'pointerdown', { clientX: from, clientY: 10 })
  fire(slide, 'pointermove', { clientX: (from + to) / 2, clientY: y })
  fire(slide, 'pointermove', { clientX: to, clientY: y })
  fire(slide, 'pointerup', { clientX: to, clientY: y })
  await flush()
}

const offsetOf = (slide: HTMLElement) => slide.style.transform

beforeEach(() => {
  openRowId.value = undefined
  archived = []
})

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})

describe('MessageThreadRow: deslizar', () => {
  it('um arrasto curto abre e revela a ação', async () => {
    const host = await mount()
    const slide = sized(host)
    const actions = host.querySelector('[data-testid=thread-actions]')!
    expect(actions.classList.contains('invisible')).toBe(true)

    await drag(slide, 300, 240)

    expect(offsetOf(slide)).toBe('translateX(-72px)')
    expect(openRowId.value).toBe('a')
    expect(actions.classList.contains('invisible')).toBe(false)
    expect(archived).toEqual([])
  })

  it('um arrasto mínimo volta ao lugar', async () => {
    const host = await mount()
    const slide = sized(host)

    await drag(slide, 300, 280)

    expect(offsetOf(slide)).toBe('translateX(0px)')
    expect(openRowId.value).toBeUndefined()
  })

  it('passar de 70% arquiva na hora', async () => {
    const host = await mount()
    const slide = sized(host)

    await drag(slide, 390, 50)

    expect(archived).toEqual(['a'])
    expect(offsetOf(slide)).toBe('translateX(-400px)')
  })

  it('o movimento vertical não arrasta', async () => {
    const host = await mount()
    const slide = sized(host)

    await drag(slide, 300, 290, 80)

    expect(offsetOf(slide)).toBe('translateX(0px)')
    expect(openRowId.value).toBeUndefined()
  })

  it('abrir outra linha fecha a que estava aberta', async () => {
    const host = await mount({}, ['a', 'b'])
    sized(host)
    const [one, two] = [...host.querySelectorAll<HTMLElement>('[data-testid=thread-slide]')]

    await drag(one!, 300, 200)
    await drag(two!, 300, 200)

    expect(openRowId.value).toBe('b')
    expect(offsetOf(one!)).toBe('translateX(0px)')
  })

  it('o trackpad (wheel horizontal) abre ao assentar', async () => {
    const host = await mount()
    const slide = sized(host)
    const event = fire(slide, 'wheel', { deltaX: 60, deltaY: 1 })
    fire(slide, 'wheel', { deltaX: 60, deltaY: 1 })
    expect(event.defaultPrevented).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(offsetOf(slide)).toBe('translateX(-72px)')
  })

  it('a rolagem vertical não é com a linha', async () => {
    const host = await mount()
    const slide = sized(host)

    const event = fire(slide, 'wheel', { deltaX: 2, deltaY: 40 })

    expect(event.defaultPrevented).toBe(false)
    expect(offsetOf(slide)).toBe('translateX(0px)')
  })
})

describe('MessageThreadRow: clique e ação', () => {
  it('fechada, o clique abre o fio', async () => {
    const host = await mount()
    sized(host)

    host.querySelector<HTMLElement>('[data-test=message-thread]')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/messages/a')
  })

  it('o clique logo depois de arrastar não navega', async () => {
    const host = await mount()
    const slide = sized(host)
    fire(slide, 'pointerdown', { clientX: 300, clientY: 10 })
    fire(slide, 'pointermove', { clientX: 280, clientY: 10 })
    fire(slide, 'pointerup', { clientX: 280, clientY: 10 })

    host.querySelector<HTMLElement>('[data-test=message-thread]')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/')
  })

  it('aberta, o clique só fecha', async () => {
    const host = await mount()
    const slide = sized(host)
    await drag(slide, 300, 200)
    await new Promise((resolve) => setTimeout(resolve, 5))

    host.querySelector<HTMLElement>('[data-test=message-thread]')!.click()
    await flush()

    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(offsetOf(slide)).toBe('translateX(0px)')
  })

  it('a ação revelada e o menu de três pontos emitem archive; nas arquivadas o rótulo é Voltar à caixa', async () => {
    const host = await mount({ archived: true })
    sized(host)
    expect(host.querySelector('[data-action=archive]')!.textContent).toContain('Voltar à caixa')

    host.querySelector<HTMLElement>('[data-action=archive]')!.click()
    host.querySelector<HTMLElement>('[data-test=message-thread-menu]')!.click()
    await flush()
    // O menu sai da linha (vai para o body).
    const item = document.querySelector<HTMLElement>('[data-test=message-thread-archive]')!
    expect(item.textContent).toContain('Voltar à caixa')
    expect(document.querySelector('[data-test=message-thread-status]')).toBeNull()
    item.click()
    await flush()

    expect(archived).toEqual(['a', 'a'])
    expect(document.querySelector('[data-test=message-thread-archive]')).toBeNull()
  })

  it('no pedido, o menu marca como resolvido (o respondido também) e reabre o resolvido', async () => {
    const statuses: string[] = []
    const onStatus = (_key: string, status: string) => statuses.push(status)
    const host = await mount({ thread: thread('p', { requestId: 'p', pending: 0, open: 1 }), onStatus })
    host.querySelector<HTMLElement>('[data-test=message-thread-menu]')!.click()
    await flush()
    const item = document.querySelector<HTMLElement>('[data-test=message-thread-status]')!
    expect(item.textContent).toContain('Marcar como resolvido')
    item.click()
    app?.unmount()
    document.body.innerHTML = ''

    const resolved = await mount({ thread: thread('p', { requestId: 'p', pending: 0, open: 0 }), onStatus })
    resolved.querySelector<HTMLElement>('[data-test=message-thread-menu]')!.click()
    await flush()
    expect(document.querySelector('[data-test=message-thread-status]')!.textContent).toContain('Reabrir')
    document.querySelector<HTMLElement>('[data-test=message-thread-status]')!.click()
    expect(statuses).toEqual(['resolved', 'pending'])
  })
})

describe('MessageThreadRow: item de projeto conectado', () => {
  it('mostra a etiqueta com o projeto e o servidor só no item da origem', async () => {
    const remote = await mount({ thread: thread('r', { origin: { projectId: 'logiccus', url: 'http://servidor:3000' } }) })
    expect(remote.querySelector('[data-test="thread-origin"]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('logiccus · servidor')
    app?.unmount()
    document.body.innerHTML = ''
    const local = await mount()
    expect(local.querySelector('[data-test="thread-origin"]')).toBeNull()
  })
})
