import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import AccountsView from './AccountsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const saved = {
  id: 'infoccus',
  kind: 'git-https',
  label: 'Infoccus',
  public: { baseUrl: 'https://git.infoccus.com.br/infoccus', username: 'agente', last4: 'wxyz' },
  exposesSecret: true,
  updatedAt: '2026-11-03T12:00:00Z',
  updatedBy: 'admin',
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().isAdmin = false
  const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = []
  vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init })
    if (path === '/projects') return [{ id: 'p1', name: 'Projeto 1', role: 'admin' }]
    if (path === '/projects/p1/accounts') return { accounts: [] }
    if (init?.method === 'PUT') return saved
    return {}
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AccountsView) })
  app.use(pinia).mount(host)
  await flush()
  return { host, calls }
}

function fill(element: Element | null, value: string) {
  expect(element, 'o campo existe').toBeTruthy()
  const input = element as HTMLInputElement | HTMLSelectElement
  input.value = value
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'))
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('AccountsView — Git HTTPS (servidor próprio)', () => {
  it('cadastra a URL, o usuário e o token; a lista mostra o usuário na URL e o aviso de que o agente vê o segredo', async () => {
    const { host, calls } = await mount()
    ;[...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Nova conta'))!.click()
    await flush()
    fill(host.querySelector('select'), 'git-https')
    await flush()
    expect(host.textContent).toContain('Só os repositórios sob essa URL usam a conta')
    fill(host.querySelector('input[placeholder="github-empresa1"]'), 'infoccus')
    fill(host.querySelector('input[placeholder="https://git.empresa.com.br/grupo"]'), ' https://git.infoccus.com.br/infoccus ')
    fill(host.querySelector('input[placeholder="agente"]'), 'agente')
    fill(host.querySelector('textarea'), 'tok-wxyz')
    await flush()
    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()

    const put = calls.find((call) => call.init?.method === 'PUT')
    expect(put?.path).toBe('/projects/p1/accounts/infoccus')
    expect(put?.init?.body).toMatchObject({ kind: 'git-https', public: { baseUrl: 'https://git.infoccus.com.br/infoccus', username: 'agente' }, secret: 'tok-wxyz' })
    expect(Object.keys((put?.init?.body as { public: object }).public)).toEqual(['baseUrl', 'username'])
    expect(host.textContent).toContain('agente em https://git.infoccus.com.br/infoccus')
    expect(host.textContent).toContain('o agente vê o segredo')
  })

  it('apaga pela confirmação da própria tela (o confirm() nativo não abre em navegador embutido)', async () => {
    const { host, calls } = await mount()
    vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, init })
      if (path === '/projects/p1/accounts' && !init?.method) return { accounts: [saved] }
      return init?.method === 'PUT' ? saved : {}
    })
    ;[...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Nova conta'))!.click()
    await flush()
    fill(host.querySelector('select'), 'git-https')
    await flush()
    fill(host.querySelector('input[placeholder="github-empresa1"]'), 'infoccus')
    fill(host.querySelector('input[placeholder="https://git.empresa.com.br/grupo"]'), 'https://git.infoccus.com.br/infoccus')
    fill(host.querySelector('input[placeholder="agente"]'), 'agente')
    fill(host.querySelector('textarea'), 'tok-wxyz')
    await flush()
    host.querySelector('form')!.dispatchEvent(new Event('submit'))
    await flush()

    const native = vi.spyOn(window, 'confirm')
    ;[...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apagar')!.click()
    await flush()
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Apagar a conta infoccus?')
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false)
    ;[...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apagar')!.click()
    await flush()

    expect(native).not.toHaveBeenCalled()
    expect(calls.find((call) => call.init?.method === 'DELETE')?.path).toBe('/projects/p1/accounts/infoccus')
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })
})
