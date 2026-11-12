import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import AccountMenu from './AccountMenu.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

async function mount(about: unknown) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().user = { name: 'Ana Souza', email: 'ana@x.test' } as never
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path !== '/about') throw new Error(`inesperado: ${path}`)
    if (about instanceof Error) throw about
    return about
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AccountMenu, { placement: 'side' }) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return host
}

const test = (name: string) => document.querySelector<HTMLElement>(`[data-test="${name}"]`)

async function openAbout(host: HTMLElement) {
  host.querySelector('button')!.click()
  await flush()
  test('about-item')!.click()
  await flush()
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('AccountMenu — Sobre', () => {
  it('o item abre o diálogo com a versão e o build, e fecha o menu; a leitura só acontece ao abrir', async () => {
    const host = await mount({ name: 'Agents Gateway', version: '1.0.0-alpha', build: '5bc892d' })
    host.querySelector('button')!.click()
    await flush()
    expect(test('about-item')!.textContent).toContain('Sobre')
    expect(vi.mocked(api)).not.toHaveBeenCalled()

    test('about-item')!.click()
    await flush()
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(test('about-dialog')!.textContent).toContain('Agents Gateway')
    expect(test('about-version')!.textContent).toBe('1.0.0-alpha')
    expect(test('about-build')!.textContent).toBe('5bc892d')

    ;[...test('about-dialog')!.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Fechar')!.click()
    await flush()
    expect(test('about-dialog')).toBeNull()
  })

  it('sem o build (o servidor não sabe), mostra só a versão', async () => {
    await openAbout(await mount({ name: 'Agents Gateway', version: '1.0.0-alpha' }))
    expect(test('about-version')!.textContent).toBe('1.0.0-alpha')
    expect(test('about-build')).toBeNull()
  })

  it('a leitura que falha avisa, no lugar de mostrar uma versão vazia', async () => {
    await openAbout(await mount(new Error('fora do ar')))
    expect(test('about-error')!.textContent).toContain('Não foi possível ler a versão.')
    expect(test('about-version')).toBeNull()
  })
})
