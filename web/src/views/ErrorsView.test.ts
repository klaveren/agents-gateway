import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import ErrorsView from './ErrorsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const log = (items: object[] = []) => ({
  items,
  byKind: { tool: 3, turn: 1, aborted: 0, refused: 2 },
  byTool: [
    { tool: 'bash', count: 2 },
    { tool: 'read', count: 1 },
  ],
})
const item = { at: new Date().toISOString(), kind: 'tool', conversationId: 'c-9', turn: 2, agentId: 'theo', title: 'Conserto', tool: 'bash', message: 'linha 1\nlinha 2' }

let app: App | undefined
let calls: Array<{ path: string; query?: Record<string, unknown> }>
let result: ReturnType<typeof log>

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ErrorsView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const errorCalls = () => calls.filter((call) => call.path === '/errors')

beforeEach(() => {
  calls = []
  result = log([item])
  vi.mocked(api).mockImplementation((async (path: string, request?: { query?: Record<string, unknown> }) => {
    calls.push({ path, query: request?.query })
    if (path === '/agents') return [{ id: 'theo', name: 'Theo' }]
    if (path === '/errors') return result
    return null
  }) as never)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('ErrorsView', () => {
  it('carrega com 7 dias e mostra os itens com o link da conversa', async () => {
    const host = await mount()
    expect(errorCalls()[0].query).toEqual({ days: 7 })
    const link = host.querySelector<HTMLAnchorElement>('[data-test="conversation-link"]')!
    expect(link.getAttribute('href')).toBe('/c/c-9')
    expect(link.textContent).toContain('Conserto')
    expect(host.textContent).toContain('Theo')
    expect(host.textContent).toContain('turno 2')
    expect(host.querySelector('[data-test="by-kind"]')!.textContent).toContain('3')
  })

  it('o tipo Recusado mostra status e mensagem, com link só quando há conversa', async () => {
    result = log([
      { at: new Date().toISOString(), kind: 'refused', conversationId: 'c-1', agentId: 'theo', status: 409, code: 'session_busy', origin: 'hook', message: 'busy' },
      { at: new Date().toISOString(), kind: 'refused', agentId: 'theo', status: 422, code: 'agent_unavailable', origin: 'api', message: 'indisponível' },
    ])
    const host = await mount()
    expect(host.querySelectorAll('[data-test="conversation-link"]').length).toBe(1)
    expect([...host.querySelectorAll('[data-test="status"]')].map((el) => el.textContent)).toEqual(['409 session_busy', '422 agent_unavailable'])
    expect(host.textContent).toContain('Recusado')
    await click([...host.querySelectorAll('[data-test="by-kind"] button')].find((b) => b.textContent?.includes('Recusado')))
    expect(errorCalls().at(-1)!.query).toEqual({ days: 7, kind: 'refused' })
  })

  it('sem erros mostra o estado vazio', async () => {
    result = log([])
    const host = await mount()
    expect(host.textContent).toContain('Nenhum erro no período.')
  })

  it('o período e o tipo mudam a consulta', async () => {
    const host = await mount()
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '30 dias'))
    expect(errorCalls().at(-1)!.query).toEqual({ days: 30 })
    await click([...host.querySelectorAll('[data-test="by-kind"] button')].find((b) => b.textContent?.includes('Interrompido')))
    expect(errorCalls().at(-1)!.query).toEqual({ days: 30, kind: 'aborted' })
  })

  it('clicar numa ferramenta de "Mais falham" filtra por ela; outro clique tira o filtro', async () => {
    const host = await mount()
    const chip = () => [...host.querySelectorAll('[data-test="by-tool"] button')].find((b) => b.textContent?.includes('bash'))
    await click(chip())
    expect(errorCalls().at(-1)!.query).toEqual({ days: 7, tool: 'bash' })
    await click(chip())
    expect(errorCalls().at(-1)!.query).toEqual({ days: 7 })
  })

  it('a mensagem expande no clique', async () => {
    const host = await mount()
    const message = host.querySelector('[data-test="message"]')!
    expect(message.className).toContain('line-clamp-2')
    await click(message)
    expect(message.className).not.toContain('line-clamp-2')
    expect(message.getAttribute('aria-expanded')).toBe('true')
  })
})
