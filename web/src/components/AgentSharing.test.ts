import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IAgent, IAgentDetail } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
import { useAgentsStore } from '@/stores/agents'
import { useProjectsStore } from '@/stores/projects'
import AgentsView from '@/views/AgentsView.vue'
import AgentForm from './AgentForm.vue'
import NewConversation from './NewConversation.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined
Element.prototype.scrollIntoView = () => undefined
window.matchMedia ??= (() => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })) as never

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const PROJECTS = [
  { id: 'alfa', name: 'Alfa', role: 'admin' },
  { id: 'beta', name: 'Beta', role: 'admin' },
  { id: 'gama', name: 'Gama', role: 'member' },
  { id: 'delta', name: 'Delta', role: 'admin' },
].map((project) => ({ ...project, createdAt: '', updatedAt: '' }))

const agent = (overrides: Partial<IAgentDetail> = {}): IAgentDetail => ({
  id: 'zeus',
  name: 'Zeus',
  providers: [],
  modes: ['chat'],
  allowedTools: [],
  systemPrompt: 'Oi',
  projectId: 'alfa',
  ...overrides,
})

/** `data`: o que o servidor responde por caminho (com `?project=` quando a chamada leva o projeto). */
async function mount(component: Component, props: Record<string, unknown>, current: string, data: Record<string, unknown> = {}, admin = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = admin
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }) => {
    if (path === '/projects') return PROJECTS
    if (path.endsWith('/initial-context')) return { docs: [], available: [], docIds: [], totalTokens: 0 }
    if (path === '/settings') return { audience: 'all', defaultModelGroup: 'padrao', modelGroups: [] }
    if (init?.method === 'PUT' && path.endsWith('/shares')) return { ...agent(), sharedWith: (init.body as { projects: string[] }).projects }
    const key = init?.query?.project ? `${path}?project=${init.query.project}` : path
    return data[key] ?? data[path] ?? []
  }) as never)
  const projects = useProjectsStore()
  projects.current = current
  await projects.load()
  await useAgentsStore().load()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => h('div') } }] })
  await router.push('/')
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, props) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'o elemento existe').toBeTruthy()
  ;(element as HTMLElement).click()
  await flush()
}
const q = (host: HTMLElement, test: string) => host.querySelector<HTMLElement>(`[data-test="${test}"]`)
const boxes = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('[data-test="share-projects"] input[type="checkbox"]')]

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('agente: aba Compartilhar', () => {
  it('lista só os projetos administrados (menos o do agente), marcados pelo sharedWith, e manda a lista inteira', async () => {
    const host = await mount(AgentForm, { agent: agent({ sharedWith: ['beta'] }), creating: false }, 'alfa')
    await click(q(host, 'agent-tab-compartilhar'))
    expect(boxes(host).map((box) => [box.dataset.project, box.checked])).toEqual([
      ['beta', true],
      ['delta', false],
    ])
    expect(host.textContent).toContain(
      'O outro projeto conversa com o agente, sem editar. A conversa roda na pasta e nas regras do projeto de lá. Segredos não vão junto: cada projeto configura os seus.',
    )
    await click(boxes(host)[1])
    await click(host.querySelector('[data-test="save-footer"] button'))
    expect(api).toHaveBeenCalledWith('/agents/zeus/shares', { method: 'PUT', body: { projects: ['beta', 'delta'] } })
  })

  it('agente global e agente novo não têm a aba', async () => {
    const global = await mount(AgentForm, { agent: agent({ projectId: undefined }), creating: false }, 'alfa')
    expect(q(global, 'agent-tab-compartilhar')).toBeNull()
    app?.unmount()
    document.body.innerHTML = ''
    const novo = await mount(AgentForm, { creating: true }, 'alfa')
    expect(q(novo, 'agent-tab-compartilhar')).toBeNull()
  })
})

describe('agente compartilhado: só leitura', () => {
  it('com sharedFrom abre só leitura, com o aviso, sem Salvar, Duplicar, Apagar nem Compartilhar', async () => {
    const host = await mount(AgentForm, { agent: agent({ sharedFrom: 'alfa', sharedWith: ['beta'] }), creating: false }, 'beta')
    expect(q(host, 'shared-readonly')?.textContent).toContain('Compartilhado por Alfa: só leitura aqui; a manutenção é lá.')
    expect(host.querySelector('.form-footer')).toBeNull()
    expect(host.textContent).not.toContain('Salvar agente')
    expect(host.textContent).not.toContain('Duplicar agente')
    expect(host.textContent).not.toContain('Apagar agente')
    expect(q(host, 'agent-tab-compartilhar')).toBeNull()
    expect(host.querySelector('fieldset')?.disabled).toBe(true)
  })

  it('a aba Variáveis lê e grava com ?project= do projeto atual', async () => {
    const host = await mount(AgentForm, { agent: agent({ sharedFrom: 'alfa' }), creating: false }, 'beta', { '/agents/zeus/secrets?project=beta': [] })
    await click(q(host, 'agent-tab-variaveis'))
    expect(host.textContent).toContain('Valores deste projeto (não vêm do projeto de origem)')
    expect(api).toHaveBeenCalledWith('/agents/zeus/secrets?project=beta')
    const type = (test: string, value: string) => {
      const input = q(host, test) as HTMLInputElement
      expect(input.closest('fieldset')?.disabled ?? false).toBe(false)
      input.value = value
      input.dispatchEvent(new Event('input'))
    }
    type('secret-add-name', 'API_TOKEN')
    type('secret-add-value', 'segredo')
    await flush()
    await click(q(host, 'secret-add-submit'))
    expect(api).toHaveBeenCalledWith('/agents/zeus/secrets/API_TOKEN?project=beta', { method: 'PUT', body: { value: 'segredo' } })
  })
})

describe('selo do agente compartilhado', () => {
  const shared: IAgent = {
    id: 'zeus',
    name: 'Zeus',
    providers: [{ id: 'claude', name: 'Claude', models: ['m'], pricing: {} } as never],
    modes: ['chat'],
    allowedTools: [],
    projectId: 'alfa',
    sharedFrom: 'alfa',
  }
  const own: IAgent = { ...shared, id: 'hera', name: 'Hera', projectId: 'beta', sharedFrom: undefined }

  it('na lista de agentes', async () => {
    const host = await mount(AgentsView, {}, 'beta', { '/agents?project=beta': [shared, own] })
    expect([...host.querySelectorAll('[data-test="shared-badge"]')].map((badge) => badge.textContent?.trim())).toEqual(['compartilhado por Alfa'])
  })

  it('no seletor de agente da conversa nova', async () => {
    const host = await mount(NewConversation, {}, 'beta', { '/agents?project=beta': [shared, own] })
    expect([...host.querySelectorAll('[data-test="shared-badge"]')].map((badge) => badge.textContent?.trim())).toEqual(['compartilhado por Alfa'])
  })
})

describe('agente global: a camada do projeto', () => {
  const ATLAS = agent({ id: 'atlas', name: 'Atlas', projectId: undefined, allowedTools: ['agent:construtor'] })
  const LAYER = {
    agentId: 'atlas',
    projectId: 'alfa',
    origin: { providers: [], allowedTools: ['agent:construtor'], permissions: [] },
    layer: { allowedTools: [], disabledTools: [], permissions: [] },
  }

  it('quem administra o projeto edita a camada dele: o aviso diz o projeto, e a Memória e as Variáveis são deste projeto', async () => {
    const host = await mount(AgentForm, { agent: ATLAS, creating: false }, 'alfa', {
      '/projects/alfa/agents/atlas/layer': LAYER,
      '/agents/atlas/ledger?project=alfa': { agentId: 'atlas@alfa', contexts: [], lineCount: 0, warnings: [] },
    })
    expect(q(host, 'project-layer')?.textContent).toContain('Camada de Alfa')
    expect(q(host, 'layer-scope-base')).toBeNull()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/projects/alfa/agents/atlas/layer')
    await click(q(host, 'agent-tab-memoria'))
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).startsWith('/agents/atlas/ledger?project=alfa'))).toBe(true)
    await click(q(host, 'agent-tab-variaveis'))
    expect(q(host, 'project-layer-secrets')?.textContent).toContain('vale o da base')
  })

  it('o admin do gateway escolhe: a base (como sempre) ou a camada do projeto', async () => {
    const host = await mount(AgentForm, { agent: ATLAS, creating: false }, 'alfa', { '/projects/alfa/agents/atlas/layer': LAYER }, true)
    expect(q(host, 'project-layer')?.textContent).toContain('Editando a base')
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/projects/alfa/agents/atlas/layer')
    await click(q(host, 'layer-scope-project'))
    expect(q(host, 'project-layer')?.textContent).toContain('Camada de Alfa')
    expect(vi.mocked(api)).toHaveBeenCalledWith('/projects/alfa/agents/atlas/layer')
  })
})
