import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import { machineAgentsOn } from '@/lib/machine'
import type { IProject } from '@/lib/types'
import { useProjectsStore } from '@/stores/projects'
import { useSettingsStore } from '@/stores/settings'
import MachineAgentsSetting from './MachineAgentsSetting.vue'
import MachineToggle from './MachineToggle.vue'
import ProjectSettings from './ProjectSettings.vue'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const flush = () => new Promise((resolve) => setTimeout(resolve))
const project = (extra: Partial<IProject> = {}) => ({ id: 'logiccus', name: 'Logiccus', role: 'admin', createdAt: '', updatedAt: '', ...extra }) as IProject

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const projects = useProjectsStore()
  projects.list = [project()]
  projects.current = 'logiccus'
  const host = document.createElement('div')
  document.body.appendChild(host)
  return { pinia, projects, host }
}

describe('🖥️ agentes de máquina na tela', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockResolvedValue([])
    document.body.innerHTML = ''
  })
  afterEach(() => (machineAgentsOn.value = false))

  it('Configurações: permitir pede confirmação e grava; desligar grava direto; travado pelo deploy, sem botão', async () => {
    const { pinia, host } = setup()
    const settings = useSettingsStore()
    settings.seed({ audience: 'all', deployment: { allowAnonymous: false } })
    createApp(MachineAgentsSetting).use(pinia).mount(host)
    await nextTick()
    expect(host.querySelector('[data-test="machine-agents-state"]')?.textContent?.trim()).toBe('Desligados')
    ;(host.querySelector('[data-test="machine-agents-on"]') as HTMLElement).click()
    await nextTick()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith('/settings', expect.anything())
    vi.mocked(api).mockImplementation(async (path) => (path === '/settings' ? { audience: 'all', machineAgents: true, deployment: { allowAnonymous: false } } : []))
    ;[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Permitir' && !button.dataset.test)!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenCalledWith('/settings', { method: 'PUT', body: { machineAgents: true } })
    expect(machineAgentsOn.value).toBe(true)

    settings.seed({ audience: 'all', deployment: { allowAnonymous: false, machineAgentsLocked: true } })
    await nextTick()
    expect(host.querySelector('[data-test="machine-agents-state"]')?.textContent?.trim()).toBe('Travado pelo deploy')
    expect(host.querySelector('[data-test="machine-agents-on"], [data-test="machine-agents-off"]')).toBeNull()
  })

  it('no agente: tornar de máquina pede confirmação e manda a lista inteira; voltar tira só ele', async () => {
    const { pinia, projects, host } = setup()
    projects.list = [project({ machineAgents: ['atlas'] })]
    vi.mocked(api).mockImplementation(async (_path, init) => project({ machineAgents: (init as { body: { agents: string[] } }).body.agents }))
    createApp(MachineToggle, { projectId: 'logiccus', agentId: 'zeus' }).use(pinia).mount(host)
    await nextTick()
    ;(host.querySelector('[data-test="machine-on"]') as HTMLElement).click()
    await nextTick()
    ;[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Tornar de máquina' && !button.dataset.test)!.click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/machine-agents', { method: 'PUT', body: { agents: ['atlas', 'zeus'] } })
    expect(host.querySelector('[data-test="machine-state"]')?.textContent?.trim()).toBe('Fora do cerco do projeto')
    ;(host.querySelector('[data-test="machine-off"]') as HTMLElement).click()
    await flush()
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/projects/logiccus/machine-agents', { method: 'PUT', body: { agents: ['atlas'] } })
  })

  it('Projeto → Configurações: a guia só com o sistema permitindo', async () => {
    const { pinia, host } = setup()
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
    machineAgentsOn.value = true
    createApp(ProjectSettings, { projectId: 'logiccus' }).use(pinia).use(router).mount(host)
    await flush()
    const tabs = () => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())
    expect(tabs()).toContain('Agentes de máquina')
    machineAgentsOn.value = false
    await nextTick()
    expect(tabs()).not.toContain('Agentes de máquina')
  })
})
