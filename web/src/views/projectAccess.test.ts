import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type Component } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import AccountsView from './AccountsView.vue'
import ProjectsView from './ProjectsView.vue'
import RulesView from './RulesView.vue'
import SettingsView from './SettingsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

/** `gateway`: admin do gateway (GET /settings 200); `role`: o papel da pessoa no projeto `alfa`. */
async function mount(component: Component, who: { gateway: boolean; role: 'admin' | 'member' }, props: Record<string, unknown> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.isAdmin = who.gateway
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/projects') return [{ id: 'alfa', name: 'Alfa', role: who.role, createdAt: '', updatedAt: '' }]
    if (path === '/settings') return { audience: 'all', modelGroups: [] }
    if (path === '/projects/alfa/accounts') return { accounts: [] }
    return []
  })
  const projects = useProjectsStore()
  await projects.load()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component }] })
  await router.push('/')
  await router.isReady()
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(component, props) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('acesso por projeto: telas de projeto', () => {
  it('admin do projeto vê a tela de contas', async () => {
    const host = await mount(AccountsView, { gateway: false, role: 'admin' })
    expect(host.textContent).not.toContain('Só quem administra este projeto')
  })

  it('membro comum não vê a tela de contas', async () => {
    const host = await mount(AccountsView, { gateway: false, role: 'member' })
    expect(host.textContent).toContain('Só quem administra este projeto vê as contas.')
  })

  it('admin do gateway sem papel no projeto não vê a tela de projeto', async () => {
    const host = await mount(AccountsView, { gateway: true, role: 'member' })
    expect(host.textContent).toContain('Só quem administra este projeto vê as contas.')
  })

  it('a guia Projetos abre para o admin do projeto, sem criar nem apagar', async () => {
    const host = await mount(ProjectsView, { gateway: false, role: 'admin' }, { id: 'alfa' })
    expect(host.textContent).not.toContain('Só quem administra um projeto')
    expect(host.querySelector('a[title="Novo projeto"]')).toBeNull()
    expect(host.textContent).not.toContain('Apagar projeto')
    expect(host.textContent).toContain('Salvar projeto')
  })

  it('a guia Projetos: o admin do gateway cria e apaga', async () => {
    const host = await mount(ProjectsView, { gateway: true, role: 'member' }, { id: 'alfa' })
    expect(host.querySelector('a[title="Novo projeto"]')).not.toBeNull()
    expect(host.textContent).toContain('Apagar projeto')
  })

  it('a guia Projetos: o membro comum não entra', async () => {
    const host = await mount(ProjectsView, { gateway: false, role: 'member' })
    expect(host.textContent).toContain('Só quem administra um projeto cuida dos projetos.')
  })
})

describe('acesso por projeto: item global', () => {
  it('rules globais: o admin do projeto só lê', async () => {
    const host = await mount(RulesView, { gateway: false, role: 'admin' })
    ;[...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Globais')!.click()
    await flush()
    expect(host.querySelector('[data-test="global-readonly"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Nova regra global')
  })
})

describe('acesso por projeto: sistema', () => {
  it('Configurações segue o admin do gateway, mesmo sem papel em projeto', async () => {
    const host = await mount(SettingsView, { gateway: true, role: 'member' })
    expect(host.textContent).not.toContain('Só quem administra')
  })

  it('o admin do projeto, sem ser do gateway, não vê Configurações', async () => {
    const host = await mount(SettingsView, { gateway: false, role: 'admin' })
    expect(host.querySelector('section')).toBeNull()
  })
})

describe('store de projetos', () => {
  it('seesAll vale para o admin do gateway ou do projeto atual', async () => {
    await mount(AccountsView, { gateway: false, role: 'admin' })
    expect(useProjectsStore().seesAll).toBe(true)
    app?.unmount()
    await mount(AccountsView, { gateway: false, role: 'member' })
    expect(useProjectsStore().seesAll).toBe(false)
    app?.unmount()
    await mount(AccountsView, { gateway: true, role: 'member' })
    expect(useProjectsStore().seesAll).toBe(true)
    expect(useProjectsStore().manages).toBe(false)
  })
})
