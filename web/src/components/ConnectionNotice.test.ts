import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import ConnectionNotice from './ConnectionNotice.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

describe('ConnectionNotice', () => {
  it('atualizado: Ver e Fechar na mesma linha; fechar dá por visto sem sair da tela', async () => {
    const updated = { projectId: 'logiccus-client', state: 'ok', lastUpdate: { from: 1407, to: 1408, changes: [{}], seen: false } }
    const calls: string[] = []
    vi.mocked(api).mockImplementation((async (path: string) => {
      calls.push(path)
      if (path === '/connections') return [updated]
      if (path.endsWith('/update-seen')) return { ...updated, lastUpdate: { ...updated.lastUpdate, seen: true } }
      return []
    }) as never)
    setActivePinia(createPinia())
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
    await router.push('/')
    const host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp({ render: () => h(ConnectionNotice) })
    app.use(router).mount(host)
    await flush()
    expect(host.querySelector('[data-test="connection-updated-open"]')?.getAttribute('href')).toBe('/projects/logiccus-client')
    host.querySelector<HTMLButtonElement>('[data-test="connection-updated-close"]')!.click()
    await flush()
    expect(calls).toContain('/connections/logiccus-client/update-seen')
    expect(router.currentRoute.value.path).toBe('/')
    expect(host.querySelector('[data-test="connection-updated"]')).toBeNull()
  })
})
