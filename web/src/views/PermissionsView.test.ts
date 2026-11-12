import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import PermissionsView from './PermissionsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

type TInit = { method?: string; body?: unknown; query?: Record<string, string | number | readonly string[] | undefined> }
type TCall = { path: string; init?: TInit }

async function mount(reply?: (path: string, init?: TInit) => unknown) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const calls: TCall[] = []
  vi.mocked(api).mockImplementation(async (path: string, init?: TInit) => {
    calls.push({ path, init })
    const custom = reply?.(path, init)
    if (custom !== undefined) return custom
    if (path === '/projects') return [{ id: 'p1', name: 'Projeto 1', role: 'admin' }]
    if (path === '/projects/p1/permissions') return { projectId: 'p1', rules: [], system: [{ category: 'read', pattern: '**/.env', decision: 'deny', note: 'segredo' }] }
    return []
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/permissions', component: PermissionsView }] })
  await router.push('/permissions')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(PermissionsView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, calls }
}

const decision = (category: string, subject: string) => ({ at: '2026-11-11T12:00:00.000Z', category, subject, allowed: true, layer: 'project', pattern: '**' })

const test = (host: ParentNode, name: string) => host.querySelector<HTMLElement>(`[data-test="${name}"]`)

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('PermissionsView — as regras do sistema', () => {
  it('têm a guia delas: fora das categorias, e sem o editor nem o salvar', async () => {
    const { host } = await mount()
    expect(test(host, 'tab-terminal')!.getAttribute('aria-selected')).toBe('true')
    expect(test(host, 'system-rules')).toBeNull()
    expect(test(host, 'tab-system')!.textContent).toContain('1')

    test(host, 'tab-system')!.click()
    await flush()
    expect(test(host, 'tab-system')!.getAttribute('aria-selected')).toBe('true')
    expect(test(host, 'tab-terminal')!.getAttribute('aria-selected')).toBe('false')
    expect(test(host, 'system-rules')!.textContent).toContain('**/.env')
    expect(test(host, 'system-rules')!.textContent).toContain('segredo')
    expect(host.textContent).not.toContain('Salvar permissões')

    test(host, 'tab-read')!.click()
    await flush()
    expect(test(host, 'system-rules')).toBeNull()
    expect(test(host, 'tab-read')!.getAttribute('aria-selected')).toBe('true')
  })
})

describe('PermissionsView — a guia manda no teste e nas últimas decisões', () => {
  const DECISIONS = '/projects/p1/permissions/decisions'

  it('o teste roda na categoria da guia: o campo só mostra qual é', async () => {
    const { host, calls } = await mount((path) => (path === '/projects/p1/permissions/test' ? { allowed: true, parts: [] } : undefined))
    const category = () => test(host, 'tester-category') as HTMLSelectElement
    expect([category().disabled, category().value]).toEqual([true, 'terminal'])

    test(host, 'tab-mcp')!.click()
    await flush()
    expect([category().disabled, category().value]).toEqual([true, 'mcp'])
    const input = category().parentElement!.querySelector('input')!
    input.value = 'gateway/list_agents'
    input.dispatchEvent(new Event('input'))
    await flush()
    ;[...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Testar')!.click()
    await flush()
    expect(calls.find((call) => call.path === '/projects/p1/permissions/test')?.init?.body).toEqual({ category: 'mcp', value: 'gateway/list_agents' })
  })

  it('as decisões são só as da guia aberta, e trocam com ela', async () => {
    const { host, calls } = await mount((path, init) => (path === DECISIONS ? [decision(String(init?.query?.category), `pedido de ${init?.query?.category}`)] : undefined))
    const asked = () => calls.filter((call) => call.path === DECISIONS).map((call) => call.init?.query)
    expect(asked()).toEqual([{ category: 'terminal' }])
    expect(host.querySelectorAll('[data-test="decision"]')).toHaveLength(1)
    expect(host.textContent).toContain('pedido de terminal')

    test(host, 'tab-network')!.click()
    await flush()
    expect(asked().at(-1)).toEqual({ category: 'network' })
    expect(host.textContent).toContain('pedido de network')
    expect(host.textContent).not.toContain('pedido de terminal')
  })

  it('vêm de 10 em 10, com o pager; a guia sem decisão diz de qual categoria', async () => {
    const many = Array.from({ length: 23 }, (_, index) => decision('terminal', `comando ${index + 1}`))
    const { host } = await mount((path, init) => (path === DECISIONS ? (init?.query?.category === 'terminal' ? many : []) : undefined))
    const shown = () => [...host.querySelectorAll('[data-test="decision"]')].map((row) => row.querySelector('code')!.textContent)
    expect(shown()).toEqual(many.slice(0, 10).map((entry) => entry.subject))
    expect(test(host, 'pager')!.textContent).toContain('1–10 de 23')

    test(host, 'pager-next')!.click()
    await flush()
    test(host, 'pager-next')!.click()
    await flush()
    expect(shown()).toEqual(['comando 21', 'comando 22', 'comando 23'])

    test(host, 'tab-read')!.click()
    await flush()
    expect(test(host, 'pager')).toBeNull()
    expect(test(host, 'no-decisions')!.textContent).toContain('Ler arquivos')
  })
})
