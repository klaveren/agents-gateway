import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import SettingsView from './SettingsView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

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

describe('SettingsView — grupo de modelos padrão', () => {
  async function mount(defaultModelGroup?: string) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().isAdmin = true
    const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = []
    vi.mocked(api).mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, init })
      if (path === '/settings' && !init?.method)
        return {
          audience: 'all',
          modelGroups: [
            { id: 'padrao', name: 'Padrão', steps: [] },
            { id: 'rapido', name: 'Rápido', steps: [] },
          ],
          ...(defaultModelGroup ? { defaultModelGroup } : {}),
        }
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
    app = createApp({ render: () => h(SettingsView) })
    app.use(pinia).use(router).mount(host)
    await flush()
    return { host, calls, router }
  }
  const select = (host: HTMLElement) => host.querySelector<HTMLSelectElement>('select[aria-label="Sequência padrão"]')!
  const save = () => [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Salvar configurações')!
  const putOf = (calls: Array<{ path: string; init?: { method?: string; body?: unknown } }>) => calls.find((call) => call.init?.method === 'PUT')?.init?.body

  it('mostra Nenhum + os grupos, o atual selecionado, e o link para gerenciar', async () => {
    const { host } = await mount('rapido')
    expect([...select(host).options].map((option) => option.textContent?.trim())).toEqual(['Nenhum', 'Padrão', 'Rápido'])
    expect(select(host).value).toBe('rapido')
    expect(host.querySelector('a[href="/model-groups"]')?.textContent).toContain('Gerenciar as sequências')
  })

  it('salva o grupo escolhido como defaultModelGroup, e Nenhum como null', async () => {
    const { host, calls } = await mount()
    select(host).value = 'padrao'
    select(host).dispatchEvent(new Event('change'))
    save().click()
    await flush()
    expect(putOf(calls)).toMatchObject({ defaultModelGroup: 'padrao' })
    calls.length = 0
    select(host).value = ''
    select(host).dispatchEvent(new Event('change'))
    save().click()
    await flush()
    expect(putOf(calls)).toMatchObject({ defaultModelGroup: null })
  })

  it('guias: Geral abre primeiro; a guia vai para o endereço; o salvar some onde não vale', async () => {
    const { host, router } = await mount()
    const tab = (id: string) => host.querySelector<HTMLButtonElement>(`[data-test="settings-tab-${id}"]`)!
    const visible = (element: Element | null) => !!element && (element as HTMLElement).style.display !== 'none'
    expect(tab('general').getAttribute('aria-selected')).toBe('true')
    expect(visible(select(host).closest('section'))).toBe(false)
    tab('models').click()
    await flush()
    expect(router.currentRoute.value.hash).toBe('#models')
    expect(visible(select(host).closest('section'))).toBe(true)
    expect(save()).toBeTruthy()
    tab('notices').click()
    await flush()
    expect(save()).toBeUndefined()
    await router.replace({ hash: '#limits' })
    await flush()
    expect(tab('limits').getAttribute('aria-selected')).toBe('true')
  })
})
