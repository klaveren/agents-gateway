import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useProjectsStore } from './projects'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

describe('useProjectsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    localStorage.clear()
  })

  it('quem pede enquanto a leitura não volta espera a mesma: uma chamada só', async () => {
    let release: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => (release = resolve)) as never)
    const projects = useProjectsStore()
    const both = Promise.all([projects.load(), projects.load()])
    release([{ id: 'alfa', name: 'Alfa' }])
    await both
    expect(api).toHaveBeenCalledTimes(1)
    vi.mocked(api).mockResolvedValueOnce([{ id: 'alfa', name: 'Alfa' }])
    await projects.load()
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('o guardado que não existe mais (ou de que a pessoa saiu) cai no primeiro que ela tem', async () => {
    localStorage.setItem('gw.project', 'sumiu')
    vi.mocked(api).mockResolvedValueOnce([
      { id: 'alfa', name: 'Alfa' },
      { id: 'beta', name: 'Beta' },
    ])
    const projects = useProjectsStore()
    await projects.load()
    expect(projects.current).toBe('alfa')
    expect(projects.query).toEqual({ project: 'alfa' })
    expect(localStorage.getItem('gw.project')).toBe('alfa')
  })

  it('o guardado que continua valendo fica; sem projeto nenhum, a consulta vai sem `project`', async () => {
    localStorage.setItem('gw.project', 'beta')
    vi.mocked(api).mockResolvedValueOnce([
      { id: 'alfa', name: 'Alfa' },
      { id: 'beta', name: 'Beta' },
    ])
    const projects = useProjectsStore()
    await projects.load()
    expect(projects.currentProject?.name).toBe('Beta')

    vi.mocked(api).mockResolvedValueOnce([])
    await projects.load()
    expect([projects.current, projects.query]).toEqual([undefined, {}])
  })
})

describe('useProjectsStore — membros', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    localStorage.clear()
  })

  it('salvar os membros guarda a resposta (e a contagem na lista) sem reler', async () => {
    vi.mocked(api).mockResolvedValueOnce([{ id: 'alfa', name: 'Alfa', members: 0 }])
    const projects = useProjectsStore()
    await projects.ensure()
    await projects.ensure()
    vi.mocked(api).mockResolvedValueOnce([{ projectId: 'alfa', userId: 'u1', role: 'admin', addedAt: '' }])
    await projects.setMembers('alfa', [{ userId: 'u1', role: 'admin' }])
    expect(api).toHaveBeenLastCalledWith('/projects/alfa/members', { method: 'PUT', body: { members: [{ userId: 'u1', role: 'admin' }] } })
    await projects.members('alfa')

    expect(api).toHaveBeenCalledTimes(2)
    expect(projects.memberLists.get('alfa')?.map((member) => member.userId)).toEqual(['u1'])
    expect(projects.list[0]?.members).toBe(1)
  })
})
