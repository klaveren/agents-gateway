import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { createApp, h, nextTick, type App } from 'vue'
import { api, ApiError, openStream } from '@/lib/api'
import LiveBrowser from './LiveBrowser.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn(), openStream: vi.fn() }))

let app: App | undefined

// O jsdom não tem ResizeObserver.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  },
)

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
  vi.mocked(openStream).mockReset()
})

/** O SSE do gateway dizendo que o navegador está fechado. */
function closedStream() {
  const body = 'event: browser.state\ndata: {"live":false}\n\n'
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
    },
  })
}

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(interactive = true) {
  vi.mocked(openStream).mockResolvedValue(closedStream())
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(LiveBrowser, { sessionId: 's1', interactive }) })
  app.mount(host)
  await flush()
  return host
}

describe('LiveBrowser — a pessoa abre o navegador', () => {
  it('fechado: endereço editável e botão Abrir navegador chamam /browser/open', async () => {
    vi.mocked(api).mockResolvedValue({ live: true } as never)
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>('[data-test="live-browser-url"]')!
    expect(input.readOnly).toBe(false)
    expect(input.placeholder).toBe('Digite um endereço para abrir o navegador')
    expect(host.querySelector('[data-test="live-browser-empty"]')?.textContent).toContain('o agente usa este mesmo navegador, já logado')

    host.querySelector<HTMLButtonElement>('[data-test="live-browser-open"]')!.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/sessions/s1/browser/open', { method: 'POST', body: {} })
  })

  it('Enter no endereço abre com https quando falta o esquema', async () => {
    vi.mocked(api).mockResolvedValue({ live: true } as never)
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>('[data-test="live-browser-url"]')!
    input.value = 'example.com/login'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(api).toHaveBeenCalledWith('/sessions/s1/browser/open', { method: 'POST', body: { url: 'https://example.com/login' } })
  })

  it('mostra o erro na tela quando o servidor não tem navegador', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError(409, 'browser_unavailable', 'No browser'))
    const host = await mount()
    host.querySelector<HTMLButtonElement>('[data-test="live-browser-open"]')!.click()
    await flush()
    expect(host.querySelector('[data-test="live-browser-open-error"]')?.textContent).toContain('não tem um navegador')
  })

  it('só olhando (sem interactive): endereço somente leitura e sem botão', async () => {
    const host = await mount(false)
    expect(host.querySelector<HTMLInputElement>('[data-test="live-browser-url"]')!.readOnly).toBe(true)
    expect(host.querySelector('[data-test="live-browser-open"]')).toBeNull()
  })
})

describe('LiveBrowser — teclado com acento, ç e IME', () => {
  async function mountLive() {
    vi.mocked(api).mockResolvedValue({} as never)
    vi.mocked(openStream).mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: browser.state\ndata: {"live":true}\n\n'))
        },
      }),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    // Com o Pinia, sem stream da caixa de entrada: o navegador cai no endpoint dedicado (o mock acima).
    app = createApp({ render: () => h(LiveBrowser, { sessionId: 's1', interactive: true }) }).use(createPinia())
    app.mount(host)
    await flush()
    const field = host.querySelector<HTMLTextAreaElement>('[data-test="live-browser-typing"]')!
    field.focus()
    return field
  }
  const inputs = () =>
    vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === '/sessions/s1/browser/input')
      .map(([, options]) => (options as { body: unknown }).body)

  it('acento por composição (tecla morta) chega como texto "á", uma vez', async () => {
    const field = await mountLive()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Dead', code: 'Quote', bubbles: true }))
    field.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    field.value = '´'
    field.dispatchEvent(new InputEvent('input', { data: '´', isComposing: true }))
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'á', code: 'KeyA', isComposing: true, bubbles: true }))
    field.value = 'á'
    field.dispatchEvent(new InputEvent('input', { data: 'á', isComposing: true }))
    field.dispatchEvent(new CompositionEvent('compositionend', { data: 'á' }))
    field.dispatchEvent(new InputEvent('input', { data: 'á' }))
    await flush()
    expect(inputs()).toEqual([{ type: 'text', text: 'á' }])
    expect(field.value).toBe('')
  })

  it('ç com Option (Alt) chega como texto, não como atalho', async () => {
    const field = await mountLive()
    const keydown = new KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, cancelable: true })
    field.dispatchEvent(keydown)
    expect(keydown.defaultPrevented).toBe(false)
    field.value = 'ç'
    field.dispatchEvent(new InputEvent('input', { data: 'ç' }))
    await flush()
    expect(inputs()).toEqual([{ type: 'text', text: 'ç' }])
  })

  it('letra comum vai só como texto; Enter e Backspace seguem como tecla', async () => {
    const field = await mountLive()
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }))
    field.value = 'a'
    field.dispatchEvent(new InputEvent('input', { data: 'a' }))
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    field.dispatchEvent(enter)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true }))
    await flush()
    expect(enter.defaultPrevented).toBe(true)
    expect(inputs()).toEqual([
      { type: 'text', text: 'a' },
      { type: 'key', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 },
      { type: 'key', key: 'Backspace', code: 'Backspace', keyCode: 8, text: undefined, modifiers: 0 },
    ])
  })
})

describe('LiveBrowser — rolar com o dedo no celular', () => {
  async function mountWithFrame() {
    vi.mocked(api).mockResolvedValue({} as never)
    vi.mocked(openStream).mockResolvedValue(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const frame = JSON.stringify({ data: 'AAAA', url: 'https://x.test', width: 800, height: 1600 })
          controller.enqueue(new TextEncoder().encode(`event: browser.state\ndata: {"live":true}\n\nevent: browser.frame\ndata: ${frame}\n\n`))
        },
      }),
    )
    const host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({ render: () => h(LiveBrowser, { sessionId: 's1', interactive: true }) }).use(createPinia())
    app.mount(host)
    await flush()
    const image = host.querySelector<HTMLImageElement>('[data-test="live-browser-frame"]')!
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) })
    return image
  }
  const inputs = () =>
    vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === '/sessions/s1/browser/input')
      .map(([, options]) => (options as { body: { type: string; deltaY?: number } }).body)
  const touchAt = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 100, clientY: y }] })
    return event
  }

  it('subir o dedo desce a página: vira roda na aba, na escala da aba; o clique do fim do toque é ignorado', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const image = await mountWithFrame()
      image.dispatchEvent(touchAt('touchstart', 500))
      const move = touchAt('touchmove', 400)
      image.dispatchEvent(move)
      image.dispatchEvent(touchAt('touchend', 400))
      image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 400 }))
      await vi.advanceTimersByTimeAsync(60)
      await flush()
      expect(move.defaultPrevented).toBe(true)
      const sent = inputs()
      expect(sent.filter((body) => body.type === 'click')).toEqual([])
      expect(sent.filter((body) => body.type === 'wheel').map((body) => body.deltaY)).toEqual([200])
    } finally {
      vi.useRealTimers()
    }
  })

  it('um toque sem arrastar segue como clique, sem rolar', async () => {
    const image = await mountWithFrame()
    image.dispatchEvent(touchAt('touchstart', 500))
    image.dispatchEvent(touchAt('touchend', 500))
    image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 500 }))
    await flush()
    const sent = inputs()
    expect(sent.some((body) => body.type === 'click')).toBe(true)
    expect(sent.some((body) => body.type === 'wheel')).toBe(false)
  })
})
