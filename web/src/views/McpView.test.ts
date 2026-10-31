import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { api } from '@/lib/api'
import type { IMcpServer } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import McpView from './McpView.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const server: IMcpServer = {
  key: 'alfa.crm',
  id: 'crm',
  projectId: 'alfa',
  name: 'CRM interno',
  kind: 'remote',
  url: 'https://bot:s3nh4@crm.exemplo.com/mcp?token=abc',
  transport: 'http',
  auth: 'header',
  headerName: 'Authorization',
  identity: true,
  enabled: true,
  secret: { configured: true },
  status: { connected: true },
  agents: [{ id: 'vendas', name: 'Vendas' }],
  selfReference: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}

const history = {
  kind: 'mcp',
  itemId: 'alfa.crm',
  current: { exists: true, hash: 'h2' },
  total: 2,
  page: 1,
  pageSize: 20,
  revisions: [
    { id: 2, kind: 'mcp', itemId: 'alfa.crm', projectId: 'alfa', revision: 2, op: 'update', hash: 'h2', at: '2026-10-30T10:00:00Z', by: 'admin@x.com', source: 'api' },
    { id: 1, kind: 'mcp', itemId: 'alfa.crm', projectId: 'alfa', revision: 1, op: 'create', hash: 'h1', at: '2026-10-29T10:00:00Z', by: 'admin@x.com', source: 'api' },
  ],
}

async function mount(path: string, admin: boolean): Promise<HTMLElement> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.user = { id: 'u1', email: 'm@x.com', name: 'Membro', role: admin ? 'admin' : 'member', disabled: false, createdAt: '', updatedAt: '' }
  auth.isAdmin = admin
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa' } as never]
  projects.current = 'alfa'
  projects.loaded = true
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/mcp', name: 'mcp', component: McpView },
      { path: '/mcp/new', name: 'mcp-new', component: McpView },
      { path: '/mcp/:id', name: 'mcp-server', component: McpView, props: true },
      { path: '/agents/:id', component: McpView },
      { path: '/login', component: McpView },
    ],
  })
  await router.push(path)
  await router.isReady()
  const host = document.createElement('div')
  createApp({ render: () => h(RouterView) })
    .use(pinia)
    .use(router)
    .mount(host)
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  return host
}

describe('McpView', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/mcp-servers') return [server]
      if (path === '/projects') return [{ id: 'alfa', name: 'Alfa' }]
      if (path.endsWith('/tools')) return []
      if (path === '/catalog/history') return history
      if (path === '/catalog/history/diff')
        return { equal: true, added: 0, removed: 0, hunks: [], unified: '', from: { revision: 1, exists: false }, to: { revision: 2, exists: true } }
      return {}
    })
  })

  it('membro: pede só os MCPs do projeto atual (`?project=`), sem as ferramentas (que são do admin)', async () => {
    await mount('/mcp/alfa.crm', false)
    expect(api).toHaveBeenCalledWith('/mcp-servers', { query: { project: 'alfa' } })
    expect(vi.mocked(api).mock.calls.every(([path, request]) => path !== '/mcp-servers' || (request as { query?: unknown })?.query)).toBe(true)
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('/tools'))).toBe(false)
  })

  it('membro: só leitura — nada de botão, campo, criar ou remover; a URL sem segredo', async () => {
    const host = await mount('/mcp/alfa.crm', false)
    const detail = host.querySelector('[data-test="mcp-readonly"]')
    expect(detail?.textContent).toContain('CRM interno')
    expect(detail?.textContent).toContain('crm')
    expect(detail?.textContent).toContain('Streamable HTTP')
    expect(detail?.textContent).toContain('chave configurada')
    expect(detail?.textContent).toContain('Sim')
    expect(host.querySelector('[data-test="mcp-url"]')?.textContent?.trim()).toBe('https://crm.exemplo.com/mcp?token=…')
    expect(host.textContent).not.toContain('s3nh4')
    // As guias (Detalhes, Histórico) só trocam o que se vê.
    expect(host.querySelectorAll('button:not([role="tab"]), input, select, textarea, form')).toHaveLength(0)
    expect(host.querySelector('a[href="/mcp/new"]')).toBeNull()
    expect(host.textContent).not.toContain('Remover MCP')
    expect(host.textContent).not.toContain('Testar conexão')
  })

  it('membro: a guia Histórico do MCP do projeto, só leitura (sem restaurar)', async () => {
    const host = await mount('/mcp/alfa.crm', false)
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent?.trim() === 'Histórico')
    tab!.click()
    for (let i = 0; i < 4; i++) await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
    expect(api).toHaveBeenCalledWith('/catalog/history', { query: { kind: 'mcp', id: 'alfa.crm', page: 1, pageSize: 20 } })
    expect(host.querySelectorAll('[data-test="revisions"] li')).toHaveLength(2)
    host.querySelector<HTMLButtonElement>('[data-revision="1"]')!.click()
    await nextTick()
    expect(host.querySelector('[data-test="restore"]')).toBeNull()
    expect(host.textContent).toContain('Só quem administra restaura versões.')
  })

  it('admin: inalterado — a lista inteira, sem `?project=`, com criar, editar e remover', async () => {
    const host = await mount('/mcp/alfa.crm', true)
    expect(api).toHaveBeenCalledWith('/mcp-servers')
    expect(api).not.toHaveBeenCalledWith('/mcp-servers', { query: { project: 'alfa' } })
    expect(host.querySelector('[data-test="mcp-readonly"]')).toBeNull()
    expect(host.querySelector('a[href="/mcp/new"]')).not.toBeNull()
    expect(host.textContent).toContain('Remover MCP')
    expect(host.textContent).toContain('Testar conexão')
  })
})
