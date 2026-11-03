import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { IMcpServer } from '@/lib/types'
import { useMcpStore } from './mcp'

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
  openStream: vi.fn(),
  ApiError: class extends Error {},
  authHeaders: () => ({}),
  setUnauthorizedHandler: vi.fn(),
  CALLER_TOKEN_KEY: 'k',
}))

const server = (key: string, projectId?: string): IMcpServer => ({ key, id: key.split('.').at(-1) ?? key, projectId, name: key, enabled: true }) as IMcpServer

describe('useMcpStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api).mockReset()
  })

  it('a lista do admin e a do membro de um projeto são separadas: ler uma não apaga a outra', async () => {
    vi.mocked(api).mockImplementation(
      async (_path: string, request?: { query?: { project?: string } }) =>
        (request?.query?.project ? [server('alfa.crm', 'alfa')] : [server('n8n'), server('alfa.crm', 'alfa')]) as never,
    )
    const mcp = useMcpStore()
    await mcp.ensure()
    await mcp.byProject.ensure('alfa')

    expect(mcp.list.map((one) => one.key)).toEqual(['n8n', 'alfa.crm'])
    expect(mcp.byProject.get('alfa')?.map((one) => one.key)).toEqual(['alfa.crm'])
  })

  it('as ferramentas são lidas uma vez por servidor; mudar de escopo troca o servidor pela chave nova, sem reler a lista', async () => {
    vi.mocked(api).mockImplementation(async (path: string, request?: { method?: string }) => {
      if (path === '/mcp-servers' && !request?.method) return [server('n8n')] as never
      if (path.endsWith('/tools')) return [{ name: 'run' }] as never
      if (path === '/mcp-servers/n8n') return server('alfa.n8n', 'alfa') as never
      return { tools: [] } as never
    })
    const mcp = useMcpStore()
    await mcp.ensure()
    await Promise.all([mcp.ensureTools('n8n'), mcp.ensureTools('n8n')])
    expect(mcp.tools.n8n?.map((tool) => tool.name)).toEqual(['run'])

    await mcp.update('n8n', { projectId: 'alfa' })
    expect(mcp.list.map((one) => one.key)).toEqual(['alfa.n8n'])
    expect(mcp.tools.n8n).toBeUndefined()
    expect(vi.mocked(api).mock.calls.filter(([path, request]) => path === '/mcp-servers' && !(request as { method?: string } | undefined)?.method)).toHaveLength(1)
    expect(vi.mocked(api).mock.calls.filter(([path]) => /^\/mcp-servers\/.+\/tools$/.test(String(path)))).toHaveLength(1)
  })
})
