import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { api } from '@/lib/api'
import { useAgentsStore } from '@/stores/agents'
import { useProjectsStore } from '@/stores/projects'
import EnvFilesAgents from './EnvFilesAgents.vue'
import EnvFilesToggle from './EnvFilesToggle.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = () => new Promise((resolve) => setTimeout(resolve))
const button = (text: string) => [...document.querySelectorAll('button')].find((one) => one.textContent?.trim() === text)!

function setup(envFileAgents?: string[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const projects = useProjectsStore()
  projects.list = [{ id: 'logiccus', name: 'Logiccus', role: 'admin', createdAt: '', updatedAt: '', ...(envFileAgents ? { envFileAgents } : {}) }]
  projects.current = 'logiccus'
  const host = document.createElement('div')
  document.body.appendChild(host)
  return { pinia, projects, host }
}

describe('a leitura dos .env, por agente', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    document.body.innerHTML = ''
  })

  it('⚠️ na aba do agente: ligar pede confirmação e acrescenta SÓ ele; fechar tira só ele, sem perguntar', async () => {
    const { pinia, projects, host } = setup(['atlas'])
    createApp(EnvFilesToggle, { projectId: 'logiccus', agentId: 'zeus' }).use(pinia).mount(host)
    await nextTick()
    expect(host.querySelector('[data-test="env-files-state"]')?.textContent?.trim()).toBe('Fechados')

    ;(host.querySelector('[data-test="env-files-open"]') as HTMLElement).click()
    await nextTick()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], envFileAgents: ['atlas', 'zeus'] } as never)
    button('Deixar ler').click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { agents: ['atlas', 'zeus'] } })
    await nextTick()
    expect(host.querySelector('[data-test="env-files-state"]')?.textContent?.trim()).toBe('Este agente lê')

    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], envFileAgents: ['atlas'] } as never)
    ;(host.querySelector('[data-test="env-files-close"]') as HTMLElement).click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { agents: ['atlas'] } })
  })

  it('⚠️ em Sistema: marca os agentes e salva; acrescentar pede confirmação; o removido aparece para sair', async () => {
    const { pinia, projects, host } = setup(['velho'])
    useAgentsStore().list = [
      { id: 'zeus', name: 'Zeus' },
      { id: 'atlas', name: 'Atlas' },
    ] as never
    createApp(EnvFilesAgents, { projectId: 'logiccus' }).use(pinia).mount(host)
    await nextTick()
    expect(host.textContent).toContain('agente removido')
    const save = host.querySelector('[data-test="env-files-save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)

    const zeus = host.querySelector('[data-agent="zeus"]') as HTMLInputElement
    zeus.checked = true
    zeus.dispatchEvent(new Event('change'))
    const old = host.querySelector('[data-agent="velho"]') as HTMLInputElement
    old.checked = false
    old.dispatchEvent(new Event('change'))
    await nextTick()
    save.click()
    await nextTick()
    expect(vi.mocked(api)).not.toHaveBeenCalled()
    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], envFileAgents: ['zeus'] } as never)
    button('Deixar ler').click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { agents: ['zeus'] } })
  })

  it('tirar todos salva sem perguntar', async () => {
    const { pinia, projects, host } = setup(['zeus'])
    useAgentsStore().list = [{ id: 'zeus', name: 'Zeus' }] as never
    createApp(EnvFilesAgents, { projectId: 'logiccus' }).use(pinia).mount(host)
    await nextTick()
    const zeus = host.querySelector('[data-agent="zeus"]') as HTMLInputElement
    zeus.checked = false
    zeus.dispatchEvent(new Event('change'))
    await nextTick()
    vi.mocked(api).mockResolvedValueOnce({ ...projects.list[0], envFileAgents: undefined } as never)
    ;(host.querySelector('[data-test="env-files-save"]') as HTMLElement).click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/env-files', { method: 'PUT', body: { agents: [] } })
  })
})
