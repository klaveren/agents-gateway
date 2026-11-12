import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import PermissionsView from './PermissionsView.vue'

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
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/projects') return [{ id: 'p1', name: 'Projeto 1', role: 'admin' }]
    if (path === '/projects/p1/permissions')
      return { projectId: 'p1', rules: [], system: [{ category: 'read', pattern: '**/.env', decision: 'deny', note: 'segredo' }] }
    return []
  })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/permissions', component: PermissionsView }] })
  await router.push('/permissions')
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(PermissionsView) })
  app.use(pinia).use(router).mount(host)
  await flush()
  return { host }
}

const test = (host: ParentNode, name: string) => host.querySelector<HTMLElement>(`[data-test="${name}"]`)

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('PermissionsView — as regras do sistema', () => {
  it('têm a guia delas: fora das categorias, e sem o editor nem o salvar', async () => {
    const { host } = await mount()
    expect(test(host, 'tab-terminal')!.getAttribute('aria-selected')).toBe('true')
    expect(test(host, 'system-rules')).toBeNull()
    expect(test(host, 'tab-system')!.textContent).toContain('1')

    test(host, 'tab-system')!.click()
    await flush()
    expect(test(host, 'tab-system')!.getAttribute('aria-selected')).toBe('true')
    expect(test(host, 'tab-terminal')!.getAttribute('aria-selected')).toBe('false')
    expect(test(host, 'system-rules')!.textContent).toContain('**/.env')
    expect(test(host, 'system-rules')!.textContent).toContain('segredo')
    expect(host.textContent).not.toContain('Salvar permissões')

    test(host, 'tab-read')!.click()
    await flush()
    expect(test(host, 'system-rules')).toBeNull()
    expect(test(host, 'tab-read')!.getAttribute('aria-selected')).toBe('true')
  })
})
