import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import PackagesView from './PackagesView.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const state = (npmAvailable = true) => ({
  available: true,
  prefix: '/tools',
  packages: [{ name: 'git', version: '2.45.0', explicit: true }],
  npm: { available: npmAvailable, prefix: '/npm', packages: [{ name: '@scope/cli', version: '1.0.0', explicit: true }] },
})

async function flush() {
  for (let i = 0; i < 4; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
}

async function mount(npmAvailable = true): Promise<HTMLElement> {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  auth.isAdmin = true
  vi.mocked(api).mockImplementation((async (path: string, request?: { method?: string; body?: unknown }) => {
    if (path === '/packages' && !request?.method) return state(npmAvailable)
    if (path.startsWith('/packages/search')) return [{ name: 'mongosh', version: '2.3.0', license: 'Apache-2.0' }]
    if (path === '/packages' && request?.method === 'POST') return { ok: true, log: '', source: 'npm', packages: [{ name: 'mongosh', version: '2.3.0', explicit: true }] }
    return { ok: true, log: '', packages: [] }
  }) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  createApp(PackagesView).use(pinia).mount(host)
  await flush()
  return host
}

const click = async (element: Element | null | undefined) => {
  ;(element as HTMLElement).click()
  await flush()
}

async function search(host: HTMLElement, text: string) {
  const input = host.querySelector<HTMLInputElement>('label input')!
  input.value = text
  input.dispatchEvent(new Event('input'))
  await new Promise((resolve) => setTimeout(resolve, 600))
  await flush()
}

describe('PackagesView — npm', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('conda-forge continua o padrão: a busca não leva source', async () => {
    const host = await mount()
    await search(host, 'git')
    expect(api).toHaveBeenCalledWith('/packages/search?q=git')
    expect(host.textContent).toContain('Instalados')
    expect(host.textContent).not.toContain('Instalados (npm)')
  })

  it('npm: busca com source=npm, lista os instalados em seção própria e mostra a nota', async () => {
    const host = await mount()
    await click(host.querySelector('[data-source="npm"]'))
    await search(host, 'mongosh')
    expect(api).toHaveBeenCalledWith('/packages/search?q=mongosh&source=npm')
    expect(host.textContent).toContain('Instalados (npm)')
    expect(host.textContent).toContain('@scope/cli')
    expect(host.textContent).toContain('os scripts de instalação não rodam')
  })

  it('npm: Instalar abre a versão preenchida e envia { source, name, version }', async () => {
    const host = await mount()
    await click(host.querySelector('[data-source="npm"]'))
    await search(host, 'mongosh')
    await click([...host.querySelectorAll('li button')].find((b) => b.textContent?.trim() === 'Instalar'))
    const field = host.querySelector<HTMLInputElement>('[data-test="npm-version"]')!
    expect(field.value).toBe('2.3.0')
    field.value = '2.2.1'
    field.dispatchEvent(new Event('input'))
    await flush()
    await click(host.querySelector('[data-test="npm-confirm"]'))
    expect(api).toHaveBeenCalledWith('/packages', { method: 'POST', body: { source: 'npm', name: 'mongosh', version: '2.2.1' } })
    expect(host.textContent).toContain('mongosh instalado')
  })

  it('npm: versão inválida bloqueia a confirmação', async () => {
    const host = await mount()
    await click(host.querySelector('[data-source="npm"]'))
    await search(host, 'mongosh')
    await click([...host.querySelectorAll('li button')].find((b) => b.textContent?.trim() === 'Instalar'))
    const field = host.querySelector<HTMLInputElement>('[data-test="npm-version"]')!
    field.value = '^2.3'
    field.dispatchEvent(new Event('input'))
    await flush()
    expect(host.querySelector<HTMLButtonElement>('[data-test="npm-confirm"]')!.disabled).toBe(true)
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(vi.mocked(api).mock.calls.some(([, request]) => (request as { method?: string } | undefined)?.method === 'POST')).toBe(false)
  })

  it('npm: desinstalar manda ?source=npm com o nome escopado codificado', async () => {
    const host = await mount()
    await click(host.querySelector('[data-source="npm"]'))
    await click([...host.querySelectorAll('[data-test="npm-installed"] button')].find((b) => b.textContent?.trim() === 'Desinstalar'))
    await click([...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Desinstalar').at(-1))
    expect(api).toHaveBeenCalledWith('/packages/%40scope%2Fcli?source=npm', { method: 'DELETE' })
  })

  it('npm indisponível: aviso no lugar da busca', async () => {
    const host = await mount(false)
    await click(host.querySelector('[data-source="npm"]'))
    expect(host.querySelector('[data-test="npm-missing"]')).not.toBeNull()
    expect(host.querySelector('label input')).toBeNull()
  })
})
