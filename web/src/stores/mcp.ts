import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IMcpContainer, IMcpProcess, IMcpServer, IMcpTool, TMcpAuth, TMcpKind, TMcpTransport } from '@/lib/types'

export interface INewMcpServer {
  id: string
  /** O projeto dono. Ausente = global. */
  projectId?: string
  name: string
  kind: TMcpKind
  container?: IMcpContainer
  process?: IMcpProcess
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  headerName?: string
  /** Envia a identidade de quem chama (agente, conversa, projeto) em cabeçalhos. */
  identity?: boolean
  secret?: string
}

/**
 * Os servidores MCP e as ferramentas de cada um, guardadas por servidor depois da 1ª leitura. O admin gerencia todos;
 * o membro de um projeto só lê os daquele projeto (`loadProject`).
 * ⚖️ Tudo pela CHAVE (`key`): `n8n` é o global, `cliente-a.n8n` o do projeto — o mesmo id pode estar em dois projetos.
 */
export const useMcpStore = defineStore('mcp', () => {
  const list = ref<IMcpServer[]>([])
  const tools = ref<Record<string, IMcpTool[]>>({})

  async function load(): Promise<void> {
    list.value = await api<IMcpServer[]>('/mcp-servers')
  }

  /**
   * ⛔ O MEMBRO de um projeto: só os MCPs daquele projeto (`?project=`), sem o erro de conexão. Sem o projeto, ou de
   * projeto alheio, o servidor responde 404 — a lista global nunca vem.
   */
  async function loadProject(projectId: string): Promise<void> {
    list.value = await api<IMcpServer[]>('/mcp-servers', { query: { project: projectId } })
  }

  async function create(input: INewMcpServer): Promise<IMcpServer> {
    const created = await api<IMcpServer>('/mcp-servers', { method: 'POST', body: input })
    await load()
    return created
  }

  /** Devolve o servidor gravado: com `projectId` (ou `null`, global) ele muda de escopo — e de chave. */
  async function update(
    id: string,
    change: Partial<Pick<IMcpServer, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'identity' | 'enabled' | 'container' | 'process'>> & { projectId?: string | null },
  ): Promise<IMcpServer> {
    const saved = await api<IMcpServer>(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    await load()
    return saved
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

  async function saveEnv(id: string, name: string, value: string): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}/env/${encodeURIComponent(name)}`, { method: 'PUT', body: { value } })
    await load()
  }

  async function stop(id: string): Promise<number> {
    const result = await api<{ stopped: number }>(`/mcp-servers/${encodeURIComponent(id)}/stop`, { method: 'POST' })
    await load()
    return result.stopped
  }

  /** `npm install` do pacote (pode levar minutos). `ok: false` traz o log do npm. */
  async function install(id: string): Promise<{ ok: boolean; version?: string; log: string }> {
    const result = await api<{ ok: boolean; version?: string; log: string }>(`/mcp-servers/${encodeURIComponent(id)}/install`, { method: 'POST' })
    await load()
    return result
  }

  async function loadTools(id: string): Promise<IMcpTool[]> {
    const result = await api<IMcpTool[]>(`/mcp-servers/${encodeURIComponent(id)}/tools`)
    tools.value = { ...tools.value, [id]: result }
    return result
  }

  return { list, tools, load, loadProject, create, update, remove, saveSecret, clearSecret, saveEnv, stop, install, test, loadTools }
})
