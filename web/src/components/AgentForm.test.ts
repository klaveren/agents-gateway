import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IAgentDetail } from '@/lib/types'
import { useAuthStore } from '@/stores/auth'
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

const AGENT: IAgentDetail = { id: 'a1', name: 'Agente', providers: [], modes: ['chat'], allowedTools: [], systemPrompt: 'Oi', ...({} as object) }

async function mount(agent: IAgentDetail) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = true
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

const select = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('select[aria-label="Grupo de modelos"]')!

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
