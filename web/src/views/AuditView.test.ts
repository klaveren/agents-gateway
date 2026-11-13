import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import AuditView from './AuditView.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 5; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const event = (id: number) => ({ id, at: '2026-11-12T10:00:00Z', action: 'PUT /settings', status: 200 })

async function mount() {
  vi.mocked(api).mockImplementation((async (_path: string, init?: { query?: Record<string, string> }) => {
    const offset = Number(init?.query?.offset ?? 0)
    const ids = Array.from({ length: Math.min(50, 120 - offset) }, (_, index) => 120 - offset - index)
    return { events: ids.map(event), total: 120 }
  }) as never)
  setActivePinia(createPinia())
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(AuditView) })
  app.use(router).mount(host)
  await flush()
  return host
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('Logs da API — as páginas', () => {
  it('pagina como as outras páginas de Logs: a faixa e o total, e a próxima página pede pelo offset', async () => {
    const host = await mount()
    expect(host.querySelector('[data-test="pager"]')?.textContent).toContain('1–50 de 120')
    host.querySelector<HTMLButtonElement>('[data-test="pager-next"]')!.click()
    await flush()
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]).toMatchObject({ query: { limit: '50', offset: '50' } })
    expect(host.querySelector('[data-test="pager"]')?.textContent).toContain('51–100 de 120')
  })
})
