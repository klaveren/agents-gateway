import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import OpenSessions from './OpenSessions.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const recent = new Date(Date.now() - 5 * 60_000).toISOString()
const SESSIONS = [
  { id: 's_here', device: 'Safari · Mac', keepSignedIn: true, createdAt: recent, lastUsedAt: recent, expiresAt: recent, current: true },
  { id: 's_phone', device: 'App · iPhone', keepSignedIn: true, createdAt: recent, lastUsedAt: recent, expiresAt: recent, current: false },
  { id: 's_old', device: 'Chrome · Windows', keepSignedIn: false, createdAt: recent, lastUsedAt: recent, expiresAt: recent, current: false },
]

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { id: 'u_1', name: 'Ana', email: 'ana@x.test', role: 'member' } as never
  let list = [...SESSIONS]
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string }) => {
    if (path === '/auth/sessions' && init?.method === 'DELETE') {
      list = list.filter((session) => session.current)
      return { expiresAt: recent, user: {} }
    }
    if (path === '/auth/sessions') return list
    const one = /^\/auth\/sessions\/(.+)$/.exec(path)
    if (one && init?.method === 'DELETE') {
      list = list.filter((session) => session.id !== one[1])
      return null
    }
    throw new Error(`inesperado: ${path}`)
  }) as never)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(OpenSessions) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const rows = (host: HTMLElement) => [...host.querySelectorAll('[data-test="session-row"]')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim())
const confirm = async () => {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].at(-1)!
  button.click()
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('OpenSessions', () => {
  it('lista aparelho e último uso; a desta tela marcada e sem "Encerrar"', async () => {
    const host = await mount()
    const listed = rows(host)
    expect(listed).toHaveLength(3)
    expect(listed[0]).toContain('Safari · Mac')
    expect(listed[0]).toContain('esta')
    expect(listed[1]).toContain('App · iPhone')
    expect(listed[1]).toContain('usada há 5 min')
    expect(host.querySelectorAll('[data-test="end-session"]')).toHaveLength(2)
  })

  it('encerrar uma: confirma, chama a rota e relê', async () => {
    const host = await mount()
    host.querySelectorAll<HTMLButtonElement>('[data-test="end-session"]')[0].click()
    await flush()
    expect(document.body.textContent).toContain('Encerrar a sessão App · iPhone?')
    await confirm()
    expect(api).toHaveBeenCalledWith('/auth/sessions/s_phone', { method: 'DELETE' })
    expect(rows(host)).toHaveLength(2)
  })

  it('encerrar as outras: fica só esta', async () => {
    const host = await mount()
    host.querySelector<HTMLButtonElement>('[data-test="end-other-sessions"]')!.click()
    await flush()
    await confirm()
    expect(api).toHaveBeenCalledWith('/auth/sessions', { method: 'DELETE' })
    expect(rows(host)).toHaveLength(1)
    expect(host.querySelector('[data-test="end-other-sessions"]')).toBeNull()
  })
})
