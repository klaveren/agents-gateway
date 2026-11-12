import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App, type Ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { lite } from '@/lib/edition'
import { forgetServers } from '@/lib/servers'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import ProjectSwitcher from './ProjectSwitcher.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))
// A edição é gravada uma vez só (`setEdition`): aqui ela é uma ref que o teste vira.
vi.mock('@/lib/edition', async (original) => ({ ...(await original<typeof import('@/lib/edition')>()), lite: (await import('vue')).ref(false) }))

type TWindow = { webkit?: unknown }
const SERVERS = [
  { id: 'local', name: 'Este Mac', local: true },
  { id: 's4', name: 'Servidor 4', url: 'https://quatro.exemplo.com' },
]

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

/** `bridge`: o que o app responde (sem ela, é o navegador). */
function install(reply: { current: string; manage: boolean }) {
  const post = vi.fn(async (_message: Record<string, unknown>) => ({ ...reply, servers: reply.manage ? SERVERS : SERVERS.map(({ id, name, local }) => ({ id, name, local })) }))
  ;(globalThis as TWindow).webkit = { messageHandlers: { gatewayServers: { postMessage: post } } }
  return post
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { name: 'Ana Souza', email: 'ana@x.test' } as never
  const projects = useProjectsStore()
  projects.list = [{ id: 'alfa', name: 'Alfa', role: 'admin', createdAt: '', updatedAt: '' }]
  projects.current = 'alfa'
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ProjectSwitcher, { placement: 'side' }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

async function openMenu(host: HTMLElement) {
  host.querySelector('button')!.click()
  await flush()
  return host.querySelector<HTMLElement>('[role="menu"]')
}

const servers = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-test="server-item"]')]

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  delete (globalThis as TWindow).webkit
  forgetServers()
  ;(lite as Ref<boolean>).value = false
})

describe('ProjectSwitcher — o servidor, no app do Mac', () => {
  it('no navegador o menu é só o de projeto', async () => {
    const host = await mount()
    const menu = await openMenu(host)
    expect(menu!.textContent).toContain('Projeto')
    expect(menu!.textContent).not.toContain('Servidor')
    expect(servers(host)).toHaveLength(0)
  })

  it('no app, o bloco Servidor vem acima dos projetos, marca o que está na janela e troca pelo id', async () => {
    const post = install({ current: 'local', manage: true })
    const host = await mount()
    const menu = await openMenu(host)
    expect(menu!.textContent!.indexOf('Servidor')).toBeLessThan(menu!.textContent!.indexOf('Projeto'))
    expect(servers(host).map((item) => [item.textContent!.trim(), item.getAttribute('aria-checked')])).toEqual([
      ['Este Mac✓', 'true'],
      ['Servidor 4', 'false'],
    ])
    expect(host.querySelector('[data-test="servers-manage"]')!.getAttribute('href')).toBe('/servers')

    servers(host)[1].click()
    await flush()
    expect(post).toHaveBeenLastCalledWith({ op: 'switch', id: 's4' })
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('escolher o servidor que já está na janela só fecha o menu', async () => {
    const post = install({ current: 's4', manage: false })
    const host = await mount()
    await openMenu(host)
    servers(host)[1].click()
    await flush()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith({ op: 'list' })
    expect(host.querySelector('[role="menu"]')).toBeNull()
  })

  it('na tela de outro servidor dá para trocar, mas o cadastro não aparece', async () => {
    install({ current: 's4', manage: false })
    const host = await mount()
    await openMenu(host)
    expect(servers(host)).toHaveLength(2)
    expect(host.querySelector('[data-test="servers-manage"]')).toBeNull()
  })

  it('na lite o botão fica parado no navegador; no app ele abre só os servidores', async () => {
    ;(lite as Ref<boolean>).value = true
    const browser = await mount()
    expect(browser.querySelector('button')!.disabled).toBe(true)
    app!.unmount()
    document.body.innerHTML = ''
    forgetServers()

    install({ current: 'local', manage: true })
    const host = await mount()
    expect(host.querySelector('button')!.disabled).toBe(false)
    const menu = await openMenu(host)
    expect(servers(host)).toHaveLength(2)
    expect(menu!.textContent).not.toContain('Projeto')
  })
})
