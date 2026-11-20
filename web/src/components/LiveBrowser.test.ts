import { afterEach, describe, expect, it, vi } from 'vitest'
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
