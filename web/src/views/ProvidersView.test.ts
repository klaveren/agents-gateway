import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import ProvidersView from './ProvidersView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('Provedores', () => {
  it('cada um diz de quem é: do gateway ou do projeto (pelo nome)', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().isAdmin = true
    const credential = { configured: true, source: 'stored' }
    vi.mocked(api).mockImplementation((async (path: string) => {
      if (path === '/providers')
        return [
          { id: 'openai', name: 'OpenAI', protocol: 'openai', official: true, enabled: true, credential },
          { id: 'p-router', name: 'Router do Alfa', protocol: 'openai', official: false, projectId: 'alfa', enabled: true, credential },
        ]
      if (path === '/projects') return [{ id: 'alfa', name: 'Alfa' }]
      return []
    }) as never)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
    await router.push('/models')
    const host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({ render: () => h(ProvidersView) })
    app.use(pinia).use(router).mount(host)
    for (let i = 0; i < 6; i++) await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
    await nextTick()
    expect([...host.querySelectorAll('[data-test="provider-scope"]')].map((tag) => tag.textContent?.trim())).toEqual(['Gateway', 'Alfa'])
  })
})
