import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import AuthView from './AuthView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(api).mockResolvedValue([] as never)
  const login = vi.spyOn(useAuthStore(), 'login').mockResolvedValue()
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/login', name: 'login', component: AuthView },
      { path: '/:any(.*)', component: { render: () => null } },
    ],
  })
  await router.push('/login')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AuthView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host, login }
}

async function submit(host: HTMLElement) {
  const fill = (selector: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(selector)!
    input.value = value
    input.dispatchEvent(new Event('input'))
  }
  fill('input[type="email"]', 'ana@x.test')
  fill('input[type="password"]', 'frase longa o bastante')
  host.querySelector('form')!.dispatchEvent(new Event('submit'))
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AuthView — Manter conectado', () => {
  it('a caixa vem marcada e vai no login', async () => {
    const { host, login } = await mount()
    const keep = host.querySelector<HTMLInputElement>('[data-test="keep-signed-in"]')!
    expect(keep.checked).toBe(true)
    expect(host.textContent).toContain('Manter conectado')

    await submit(host)
    expect(login).toHaveBeenCalledWith('ana@x.test', 'frase longa o bastante', true)
  })

  it('desmarcada: o login pede a sessão curta', async () => {
    const { host, login } = await mount()
    const keep = host.querySelector<HTMLInputElement>('[data-test="keep-signed-in"]')!
    keep.checked = false
    keep.dispatchEvent(new Event('change'))

    await submit(host)
    expect(login).toHaveBeenCalledWith('ana@x.test', 'frase longa o bastante', false)
  })
})
