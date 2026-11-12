import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IAgentDetail } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useConnectionsStore } from '@/stores/connections'
import AgentForm from './AgentForm.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

// O jsdom não tem `scrollIntoView` (a guia escolhida fica à vista).
Element.prototype.scrollIntoView = () => undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

const AGENT: IAgentDetail = {
  id: 'a1',
  name: 'Agente',
  providers: [{ id: 'claude', name: 'Anthropic', models: ['m'], pricing: {} }],
  modes: ['chat'],
  allowedTools: [],
  systemPrompt: 'Oi',
  ...({} as object),
}

async function mount(agent: IAgentDetail, extra: (path: string, init?: { method?: string; body?: unknown }) => unknown = () => undefined, connected?: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
  if (connected) useConnectionsStore().list = [{ projectId: connected, url: 'https://origem.test', state: 'ok', changes: [], skipped: [], secrets: [], modelMap: {} } as never]
  const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = []
  vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init })
    if (path === '/settings')
      return {
        audience: 'all',
        defaultModelGroup: 'padrao',
        modelGroups: [
          { id: 'padrao', name: 'Padrão', steps: [] },
          { id: 'rapido', name: 'Rápido', steps: [] },
        ],
      }
    const own = extra(path, init)
    if (own !== undefined) return own
    if (init?.method === 'PUT') return { ...agent }
    return []
  })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => h('div') } },
      { path: '/model-groups', component: { render: () => h('div') } },
    ],
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AgentForm, { agent, creating: false }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, calls }
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}

const select = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('select[aria-label="Sequência de troca"]')!

async function saveWith(host: HTMLElement, value: string) {
  select(host).value = value
  select(host).dispatchEvent(new Event('change'))
  await flush()
  host.querySelector('form')!.dispatchEvent(new Event('submit'))
  await flush()
  document.querySelector<HTMLButtonElement>('[role=alertdialog] button.btn:last-child')!.click()
  await flush()
}

describe('AgentForm — grupo de modelos', () => {
  const put = (calls: Array<{ path: string; init?: { method?: string; body?: unknown } }>) =>
    calls.find((call) => call.init?.method === 'PUT')?.init?.body as { modelGroup?: string | null }

  it('lista Padrão (nome do padrão), Nenhum e os grupos', async () => {
    const { host } = await mount(AGENT)
    expect([...select(host).options].map((option) => option.textContent?.trim())).toEqual(['Padrão (Padrão)', 'Nenhum — não troca de modelo', 'Padrão', 'Rápido'])
  })

  it('Padrão vai como null na edição', async () => {
    const { host, calls } = await mount({ ...AGENT, modelGroup: 'rapido' })
    expect(select(host).value).toBe('rapido')
    await saveWith(host, '')
    expect(put(calls).modelGroup).toBeNull()
  })

  it('sem nenhum modelo, não envia: diz em português que falta modelo e onde ativar', async () => {
    const { host, calls } = await mount({ ...AGENT, providers: [] })
    await saveWith(host, '')
    expect(put(calls)).toBeUndefined()
    expect(host.textContent).toContain('marque ao menos um modelo')
    expect(host.textContent).not.toContain('Too small')
  })

  it('Nenhum vai como "none", e um grupo vai com o id', async () => {
    const first = await mount(AGENT)
    await saveWith(first.host, 'none')
    expect(put(first.calls).modelGroup).toBe('none')
    app?.unmount()
    document.body.innerHTML = ''
    const second = await mount(AGENT)
    await saveWith(second.host, 'rapido')
    expect(put(second.calls).modelGroup).toBe('rapido')
  })
})

describe('AgentForm — MCPs', () => {
  const server = { key: 'crm', id: 'crm', name: 'CRM', enabled: true, status: { connected: true } }
  const tools = [
    { name: 'send_message', description: 'Envia uma mensagem' },
    { name: 'archive_deal', description: 'Arquiva um negócio' },
    { name: 'List_agents', description: 'Lista os agentes' },
  ]
  const mountMcp = (agent: IAgentDetail) => mount(agent, (path) => (path === '/mcp-servers' ? [server] : path === '/mcp-servers/crm/tools' ? tools : undefined))
  const chips = (host: HTMLElement) => [...host.querySelectorAll('[data-test="mcp-chips"] button')].map((button) => button.textContent?.trim().split(/\s+/)[0])

  it('as ferramentas de cada MCP em ordem alfabética, as escolhidas e não listadas no meio delas', async () => {
    const { host } = await mountMcp({ ...AGENT, allowedTools: ['mcp:crm/get_turn'] })
    expect(chips(host)).toEqual(['archive_deal', 'get_turn', 'List_agents', 'send_message'])
  })

  it('o filtro do MCP esconde o que não tem o texto (nome ou descrição) e não desmarca nada', async () => {
    const { host } = await mountMcp({ ...AGENT, allowedTools: ['mcp:crm/send_message'] })
    const filter = host.querySelector<HTMLInputElement>('[data-test="mcp-filter"]')!
    expect(filter.getAttribute('aria-label')).toBe('Filtrar ferramentas de CRM')
    filter.value = 'AGENT'
    filter.dispatchEvent(new Event('input'))
    await flush()
    expect(chips(host)).toEqual(['List_agents'])
    expect(host.querySelector('[data-test="mcp-filter-count"]')?.textContent).toBe('1 de 3')
    filter.value = 'negócio'
    filter.dispatchEvent(new Event('input'))
    await flush()
    expect(chips(host)).toEqual(['archive_deal'])
    filter.value = 'nada disso'
    filter.dispatchEvent(new Event('input'))
    await flush()
    expect(host.querySelector('[data-test="mcp-chips"]')?.textContent).toContain('Nenhuma ferramenta com esse texto.')
    filter.value = ''
    filter.dispatchEvent(new Event('input'))
    await flush()
    expect(host.querySelector('[data-test="mcp-chips"] button.on')?.textContent).toContain('send_message')
  })
})

describe('AgentForm — projeto conectado: pedido aprovado na camada local', () => {
  const LOCAL = '/connections/alfa/agents/a1/local'
  const view = (tools: string[]) => ({
    agentId: 'a1',
    projectId: 'alfa',
    origin: { providers: AGENT.providers, allowedTools: ['bash'], permissions: [] },
    layer: { allowedTools: tools, disabledTools: [], permissions: [{ category: 'terminal', pattern: 'ls', decision: 'allow' }] },
  })
  const pending = {
    id: 'pr-1',
    kind: 'agent-local',
    agentId: 'a1',
    add: [],
    remove: [],
    entries: { field: 'allowedTools', add: ['mcp:github'] },
    widenings: [{ key: 'agent/a1#allowedTools+mcp:github', description: 'Liga o MCP github' }],
    requestedWidenings: [],
    changed: false,
    reason: 'abrir PR',
    requestedBy: { by: 'root@x.test' },
    createdAt: '2026-11-03T12:00:00Z',
    expiresAt: '2026-11-10T12:00:00Z',
    status: 'pending',
  }

  it('relê a camada: o próximo "Salvar ajustes locais" leva a ferramenta aprovada e não apaga as regras locais', async () => {
    let approved = false
    const { host, calls } = await mount(
      { ...AGENT, projectId: 'alfa', allowedTools: ['bash'] },
      (path, init) => {
        if (path === '/agents/a1/permission-requests') return approved ? [] : [pending]
        if (path === '/permission-requests/pr-1/approve') {
          approved = true
          // ⚠️ A aprovação da camada local não devolve `permissions`.
          return { request: { ...pending, status: 'approved' } }
        }
        if (path.endsWith('/initial-context')) return { docIds: [], docs: [], totalTokens: 0 }
        if (path === LOCAL) return init?.method === 'PUT' ? { ...view(['mcp:github']), layer: init.body } : view(approved ? ['mcp:github'] : [])
        return undefined
      },
      'alfa',
    )
    await click([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Permissões')))
    const box = host.querySelector<HTMLInputElement>('[data-test="permission-requests"] [data-test="widening-confirm"] input[type="checkbox"]')!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await flush()
    await click(host.querySelector('[data-test="permission-requests"] [data-test="widening-submit"]'))
    expect(calls.filter((call) => call.path === LOCAL && !call.init?.method)).toHaveLength(2)

    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()
    const saved = calls.find((call) => call.path === LOCAL && call.init?.method === 'PUT')?.init?.body as { allowedTools: string[]; permissions: unknown[] }
    expect(saved.allowedTools).toEqual(['mcp:github'])
    expect(saved.permissions).toEqual([{ category: 'terminal', pattern: 'ls', decision: 'allow' }])
  })
})
