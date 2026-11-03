import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { IAgent, IAgentDetail } from '@/lib/types'
import { useAgentsStore } from './agents'
import { useProjectsStore } from './projects'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const agent = (id: string): IAgent => ({ id, name: id.toUpperCase(), providers: [], modes: ['chat'], allowedTools: [] })
const detail = (id: string, systemPrompt: string): IAgentDetail => ({ ...agent(id), systemPrompt })

describe('useAgentsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    localStorage.clear()
  })

  it('a lista é do projeto atual: `ensure` lê uma vez por projeto, e voltar a um projeto não lê de novo', async () => {
    vi.mocked(api).mockImplementation(async (_path: string, request?: { query?: { project?: string } }) => [agent(request?.query?.project ?? 'sem')] as never)
    const agents = useAgentsStore()
    const projects = useProjectsStore()
    projects.current = 'alfa'
    await Promise.all([agents.ensure(), agents.ensure()])
    projects.current = 'beta'
    await agents.ensure()
    projects.current = 'alfa'
    await agents.ensure()

    expect(api).toHaveBeenCalledTimes(2)
    expect(agents.list.map((one) => one.id)).toEqual(['alfa'])
    expect(agents.loaded).toBe(true)
  })

  it('o detalhe é lido uma vez; salvar põe a resposta na store sem reler o detalhe (só a lista, pelo `unavailable`)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, request?: { method?: string }) => {
      if (path === '/agents/a' && request?.method === 'PUT') return detail('a', 'novo') as never
      if (path === '/agents/a') return detail('a', 'velho') as never
      return [agent('a')] as never
    })
    const agents = useAgentsStore()
    await agents.detail('a')
    await agents.detail('a')
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/agents/a')).toHaveLength(1)

    await agents.save({ id: 'a', name: 'A', providers: [], modes: ['chat'], allowedTools: [], systemPrompt: 'novo' } as never, false)
    expect(agents.details.get('a')?.systemPrompt).toBe('novo')
    expect(vi.mocked(api).mock.calls.filter(([path, request]) => path === '/agents/a' && !(request as { method?: string } | undefined)?.method)).toHaveLength(1)
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/agents')).toHaveLength(1)
  })

  it('apagar tira o agente da lista sem reler', async () => {
    vi.mocked(api).mockResolvedValueOnce([agent('a'), agent('b')] as never)
    const agents = useAgentsStore()
    await agents.ensure()
    vi.mocked(api).mockResolvedValueOnce(null as never)
    await agents.remove('a')

    expect(agents.list.map((one) => one.id)).toEqual(['b'])
    expect(api).toHaveBeenCalledTimes(2)
  })
})
