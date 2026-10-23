import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IMcpServer, IMcpTool, TMcpAuth, TMcpTransport } from '@/lib/types'

export interface INewMcpServer {
  id: string
  name: string
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  headerName?: string
  secret?: string
}

/** Os servidores MCP (só admin) e as ferramentas de cada um, guardadas por servidor depois da 1ª leitura. */
export const useMcpStore = defineStore('mcp', () => {
  const list = ref<IMcpServer[]>([])
  const tools = ref<Record<string, IMcpTool[]>>({})

  async function load(): Promise<void> {
    list.value = await api<IMcpServer[]>('/mcp-servers')
  }

  async function create(input: INewMcpServer): Promise<IMcpServer> {
    const created = await api<IMcpServer>('/mcp-servers', { method: 'POST', body: input })
    await load()
    return created
  }

  async function update(id: string, change: Partial<Pick<IMcpServer, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'enabled'>>): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    await load()
  }

  async function remove(id: string): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  async function saveSecret(id: string, secret: string): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}/secret`, { method: 'PUT', body: { secret } })
    await load()
  }

  async function clearSecret(id: string): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}/secret`, { method: 'DELETE' })
    await load()
  }

  async function test(id: string): Promise<{ ok: boolean; tools: number; message?: string }> {
    const result = await api<{ ok: boolean; tools: number; message?: string }>(`/mcp-servers/${encodeURIComponent(id)}/test`, { method: 'POST' })
    await Promise.all([load(), loadTools(id)])
    return result
  }

  async function loadTools(id: string): Promise<IMcpTool[]> {
    const result = await api<IMcpTool[]>(`/mcp-servers/${encodeURIComponent(id)}/tools`)
    tools.value = { ...tools.value, [id]: result }
    return result
  }

  return { list, tools, load, create, update, remove, saveSecret, clearSecret, test, loadTools }
})
