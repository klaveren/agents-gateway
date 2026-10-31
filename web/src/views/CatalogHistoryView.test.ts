import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { api, ApiError } from '@/lib/api'
import type { IBatchPage, IScopeHistory } from '@/lib/catalogHistory'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import CatalogHistoryView from './CatalogHistoryView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

const recent: IScopeHistory = {
  scope: 'all',
  total: 3,
  page: 1,
  pageSize: 20,
  revisions: [
    {
      id: 30,
      kind: 'mcp',
      itemId: 'alfa.crm',
      projectId: 'alfa',
      revision: 2,
      op: 'import',
      hash: 'a',
      at: '2026-10-30T10:00:00Z',
      by: 'ana@x.com',
      source: 'import',
      batchId: 'lote-1',
    },
    { id: 29, kind: 'skill', itemId: 'tabela', revision: 1, op: 'import', hash: 'b', at: '2026-10-30T10:00:00Z', by: 'ana@x.com', source: 'import', batchId: 'lote-1' },
    { id: 28, kind: 'rule', itemId: 'r-1', projectId: 'alfa', revision: 3, op: 'update', hash: 'c', at: '2026-10-29T10:00:00Z', by: 'bia@x.com', source: 'api', widenings: ['x'] },
  ],
}

const lots: IBatchPage = {
  total: 2,
  page: 1,
  pageSize: 20,
  batches: [
    {
      id: 'lote-1',
      at: '2026-10-30T10:00:00Z',
      by: 'ana@x.com',
      kind: 'import',
      scope: 'all',
      summary: { applied: ['skill/tabela', 'mcp/alfa.crm'], failed: { ref: 'agent/theo', message: 'o modelo saiu' }, pending: ['agent/lia'] },
      widenings: [{ kind: 'mcp', itemId: 'alfa.crm', key: 'mcp/crm@alfa#new~remote', description: 'MCP novo' }],
      status: 'partial',
      items: 2,
    },
    { id: 'lote-0', at: '2026-10-29T10:00:00Z', by: 'bia@x.com', kind: 'import', scope: 'global', summary: {}, widenings: [], status: 'reverted', items: 4 },
  ],
}

let app: App | undefined
let revertHandler: (body: Record<string, unknown>) => unknown

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(admin: boolean, path = '/catalog/history'): Promise<HTMLElement> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = { id: 'u1', email: 'm@x.com', name: 'Pessoa', role: admin ? 'admin' : 'member', disabled: false, createdAt: '', updatedAt: '' }
  auth.isAdmin = admin
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa' } as never]
  projects.current = 'alfa'
  projects.loaded = true
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: CatalogHistoryView }] })
  await router.push(path)
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(RouterView) })
    .use(pinia)
    .use(router)
  app.mount(host)
  await flush()
  return host
}

async function click(element: Element | null | undefined) {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}

describe('CatalogHistoryView', () => {
  beforeEach(() => {
    revertHandler = () => ({ batch: { id: 'lote-2', status: 'applied' }, reverted: [], unchanged: [], conflicts: [] })
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string, request?: { body?: unknown }) => {
      if (path === '/catalog/history') return recent
      if (path === '/catalog/batches') return lots
      if (path === '/catalog/batches/lote-1/revert') return revertHandler((request?.body ?? {}) as Record<string, unknown>)
      return []
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    document.body.innerHTML = ''
  })

  it('membro: não vê a página (o histórico dele é só o do MCP, na tela do MCP)', async () => {
    const host = await mount(false)
    expect(host.textContent).toContain('Só quem administra vê o histórico do catálogo.')
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/catalog/history')).toBe(false)
  })

  it('admin: os recentes do escopo, com link para a guia Histórico do item, e os lotes da rota própria', async () => {
    const host = await mount(true, '/catalog/history?lote=lote-1')
    expect(api).toHaveBeenCalledWith('/catalog/history', { query: { project: undefined, page: 1, pageSize: 20 } })
    const rows = host.querySelectorAll('[data-test="recent"] li')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/mcp/alfa.crm#historico')
    expect(rows[1].querySelector('a')?.getAttribute('href')).toBe('/skills/tabela#historico')
    expect(rows[2].querySelector('a')?.getAttribute('href')).toBe('/rules?escopo=alfa&rule=r-1#historico')
    expect(rows[2].textContent).toContain('ampliação aceita (1)')
    expect(api).toHaveBeenCalledWith('/catalog/batches', { query: { project: undefined, page: 1, pageSize: 20 } })
    const batches = host.querySelectorAll('[data-test="batches"] li')
    expect(batches).toHaveLength(2)
    expect(batches[0].textContent).toContain('lote-1')
    expect(batches[0].textContent).toContain('2 item(ns)')
    expect(batches[0].querySelector('[data-test="batch-status"]')?.textContent).toBe('parcial')
    expect(batches[0].textContent).toContain('1 ampliação(ões) aceita(s)')
    expect(batches[0].textContent).toContain('Parou em agent/theo: o modelo saiu · 1 pendente(s)')
    expect(batches[0].className).toContain('bg-emerald-500/10')
    expect(batches[1].querySelector('[data-test="batch-status"]')?.textContent).toBe('revertido')
    expect(batches[1].querySelector<HTMLButtonElement>('[data-test="revert-batch"]')?.disabled).toBe(true)

    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="Escopo"]')!
    scope.value = 'global'
    scope.dispatchEvent(new Event('change'))
    await flush()
    expect(api).toHaveBeenCalledWith('/catalog/history', { query: { project: 'global', page: 1, pageSize: 20 } })
    expect(api).toHaveBeenCalledWith('/catalog/batches', { query: { project: 'global', page: 1, pageSize: 20 } })
  })

  it('reverter lote: 409 de ampliação pede a confirmação item por item e reenvia com confirm', async () => {
    const widenings = [{ key: 'mcp/crm@alfa#enabled~true', description: 'O MCP crm volta a ficar ligado' }]
    revertHandler = (body) => {
      if (!body.confirm) throw new ApiError(409, 'widening_confirmation_required', 'widens', { widenings })
      return {
        batch: { id: 'lote-2', status: 'partial' },
        reverted: [{ ref: 'mcp/alfa.crm', kind: 'mcp', itemId: 'alfa.crm', toRevision: 1, missingSecrets: ['CRM_TOKEN'] }],
        unchanged: [],
        conflicts: [{ ref: 'skill/tabela', kind: 'skill', itemId: 'tabela', toRevision: 0, currentRevision: 2 }],
      }
    }
    const host = await mount(true)
    await click(host.querySelector('[data-test="revert-batch"]'))
    await click([...document.body.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent?.trim() === 'Reverter'))

    const submit = host.querySelector<HTMLButtonElement>('[data-test="widening-submit"]')!
    expect(host.querySelector('[data-test="widening-confirm"]')?.textContent).toContain('O MCP crm volta a ficar ligado')
    expect(submit.disabled).toBe(true)
    await click(host.querySelector('[data-test="widening-confirm"] input[type="checkbox"]'))
    expect(submit.disabled).toBe(false)
    await click(submit)

    const calls = vi
      .mocked(api)
      .mock.calls.filter(([path]) => path === '/catalog/batches/lote-1/revert')
      .map(([, request]) => request?.body)
    expect(calls).toEqual([{}, { confirm: ['mcp/crm@alfa#enabled~true'] }])
    const result = host.querySelector('[data-test="revert-result"]')
    expect(result?.textContent).toContain('1 revertido(s)')
    expect(result?.textContent).toContain('CRM_TOKEN')
    expect(result?.textContent).toContain('skill/tabela')
  })
})
