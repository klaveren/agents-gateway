import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useProjectsStore } from './projects'

vi.mock('@/lib/api', () => ({ api: vi.fn(), openStream: vi.fn(), ApiError: class extends Error {}, authHeaders: () => ({}), setUnauthorizedHandler: vi.fn(), CALLER_TOKEN_KEY: 'k' }))

describe('useProjectsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
    localStorage.clear()
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
