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
    if (path === '/projects/logiccus/mcp-variables')
      return [{ key: 'n8n', id: 'n8n', name: 'n8n', enabled: true, fixed: [], variables: [{ name: 'N8N_API_URL', secret: false, configured: false }] }]
    if (path === '/projects/logiccus/mcp-variables/n8n/N8N_API_URL' && init?.method === 'PUT')
      return {
        key: 'n8n',
        id: 'n8n',
        name: 'n8n',
        enabled: true,
        fixed: [],
        variables: [{ name: 'N8N_API_URL', secret: false, configured: true, value: 'http://localhost:5678', local: true }],
      }
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

  it('o valor "Do projeto" de um MCP se grava nesta máquina, e aparece marcado como daqui', async () => {
    const host = await mount()
    const input = host.querySelector<HTMLInputElement>('[data-test="project-mcp-visible"]')!
    expect(input.disabled).toBe(false)
    input.value = 'http://localhost:5678'
    input.dispatchEvent(new Event('input'))
    await flush()
    const gravar = [...input.parentElement!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Gravar')!
    gravar.click()
    await flush()
    expect(api).toHaveBeenCalledWith('/projects/logiccus/mcp-variables/n8n/N8N_API_URL', { method: 'PUT', body: { value: 'http://localhost:5678' } })
    expect(host.querySelector('[data-test="project-mcp-origin"]')?.textContent).toContain('desta máquina')
  })
})
