import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import { api } from '@/lib/api'
import { useConnectionsStore, type IProjectConnection } from '@/stores/connections'
import { useProjectsStore } from '@/stores/projects'
import ProjectVariables from './ProjectVariables.vue'

vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: vi.fn() }))

let app: App | undefined

async function flush() {
  for (let i = 0; i < 6; i++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve))
  await nextTick()
}

const connection = (localEnv?: Record<string, string>) =>
  ({
    projectId: 'logiccus',
    url: 'http://10.10.0.4:3100',
    remoteProjectId: 'logiccus',
    syncedVersion: 1,
    latestVersion: 1,
    state: 'ok',
    modelMap: {},
    ...(localEnv ? { localEnv } : {}),
  }) as unknown as IProjectConnection

async function mount() {
  const pinia = createPinia()
  setActivePinia(pinia)
  vi.mocked(api).mockImplementation((async (path: string, init?: { method?: string; body?: { env: Record<string, string> } }) => {
    if (path === '/connections/logiccus/env' && init?.method === 'PUT') return connection(init.body!.env)
    return []
  }) as never)
  useProjectsStore().list = [{ id: 'logiccus', name: 'Logiccus', role: 'admin', env: { ORIGEM: 'da-origem' }, createdAt: '', updatedAt: '' }] as never
  useConnectionsStore().list = [connection({ API_BASE_URL: 'http://localhost:4000' })]
  const host = document.createElement('div')
  document.body.appendChild(host)
  app = createApp({ render: () => h(ProjectVariables, { projectId: 'logiccus' }) })
  app.use(pinia).mount(host)
  await flush()
  return host
}

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.mocked(api).mockReset()
})

describe('ProjectVariables — projeto conectado', () => {
  it('as fixas da origem ficam só leitura; as desta máquina se editam e vão no Salvar, a lista inteira', async () => {
    const host = await mount()
    expect(host.textContent).toContain('Fixas da origem')
    expect(host.querySelector<HTMLInputElement>('[data-test="project-fixed-row"] input')!.closest('fieldset')!.disabled).toBe(true)
    expect(host.querySelector('[data-test="project-fixed-add"]')).toBeNull()

    const rows = () => [...host.querySelectorAll<HTMLInputElement>('[data-test="project-local-row"] input')]
    expect(rows().map((input) => input.value)).toEqual(['API_BASE_URL', 'http://localhost:4000'])
    ;(host.querySelector('[data-test="project-local-add"]') as HTMLElement).click()
    await flush()
    rows()[2]!.value = 'GRAFANA_URL'
    rows()[2]!.dispatchEvent(new Event('input'))
    rows()[3]!.value = 'http://localhost:3001'
    rows()[3]!.dispatchEvent(new Event('input'))
    await flush()
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Salvar variáveis desta máquina'))!
    expect(save.disabled).toBe(false)
    save.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/connections/logiccus/env', { method: 'PUT', body: { env: { API_BASE_URL: 'http://localhost:4000', GRAFANA_URL: 'http://localhost:3001' } } })
    expect(host.textContent).toContain('Variáveis desta máquina salvas')
  })
})
