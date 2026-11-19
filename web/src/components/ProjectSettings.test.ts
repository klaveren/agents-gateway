import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '@/lib/api'
import type { IProject } from '@/lib/types'
import { useProjectsStore } from '@/stores/projects'
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

async function mount(project: Partial<IProject>, current: string, system = false) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const projects = useProjectsStore()
  projects.list = [
    { id: 'logiccus', name: 'Logiccus', role: 'admin', createdAt: '', updatedAt: '', ...project } as IProject,
    { id: 'outro', name: 'Outro', role: 'admin', createdAt: '', updatedAt: '' } as IProject,
  ]
  projects.current = current
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)', component: { render: () => null } }] })
  const host = document.createElement('div')
  document.body.appendChild(host)
  createApp(ProjectSettings, { projectId: 'logiccus', system }).use(pinia).use(router).mount(host)
  await flush()
  await nextTick()
  return host
}

const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())

describe('a configuração do projeto', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockResolvedValue([])
    document.body.innerHTML = ''
  })

  it('no projeto em uso, quem o administra vê Serviços e Arquivos .env; sem usar nem apagar', async () => {
    const host = await mount({}, 'logiccus')
    expect(tabs(host)).toEqual(['Projeto', 'Membros', 'Serviços', 'Modelos', 'Documentos', 'Arquivos .env'])
    expect(host.textContent).not.toContain('Usar este projeto')
  })

  it('pelo Sistema, outro projeto: sem a guia .env (a lista de agentes é a do projeto em uso), com Usar este projeto', async () => {
    const host = await mount({}, 'outro', true)
    expect(tabs(host)).toEqual(['Projeto', 'Membros', 'Serviços', 'Modelos', 'Documentos'])
    expect(host.textContent).toContain('Usar este projeto')
  })

  it('o membro (ou o admin do gateway sem papel) não vê as regras do projeto', async () => {
    const host = await mount({ role: 'member' }, 'logiccus')
    expect(tabs(host)).toEqual(['Projeto', 'Membros'])
  })
})
