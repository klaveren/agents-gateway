import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IMcpContainer, IMcpProcess, IMcpServer, IMcpTool, TMcpAuth, TMcpKind, TMcpTransport } from '@/lib/types'
import { useAgentsStore } from './agents'

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
 * Os servidores MCP e as ferramentas de cada um. Dois conjuntos SEPARADOS: o admin gerencia todos (`all`, chave única
 * `''`, que é o `list`); o membro de um projeto só lê os daquele projeto (`byProject`, a chave é o projeto). As
 * ferramentas, por servidor (`toolLists`), lidas uma vez.
 * ⚖️ Tudo pela CHAVE (`key`): `n8n` é o global, `cliente-a.n8n` o do projeto — o mesmo id pode estar em dois projetos.
 */
export const useMcpStore = defineStore('mcp', () => {
  const all = keyedResource(() => api<IMcpServer[]>('/mcp-servers'))
  /**
   * ⛔ O MEMBRO de um projeto: só os MCPs daquele projeto (`?project=`), sem o erro de conexão. Sem o projeto, ou de
   * projeto alheio, o servidor responde 404 — a lista global nunca vem.
   */
  const byProject = keyedResource((projectId) => api<IMcpServer[]>('/mcp-servers', { query: { project: projectId } }))
  const toolLists = keyedResource((key) => api<IMcpTool[]>(`/mcp-servers/${encodeURIComponent(key)}/tools`))

  const list = computed<IMcpServer[]>({
    get: () => all.get('') ?? [],
    set: (value) => all.set('', value),
  })
  const loaded = computed(() => all.has(''))
  /** As ferramentas já lidas, por chave do servidor. */
  const tools = computed<Record<string, IMcpTool[]>>(() => Object.fromEntries(toolLists.keys().map((key) => [key, toolLists.get(key) ?? []])))

  async function load(): Promise<void> {
    await all.refresh('')
  }

  async function ensure(): Promise<void> {
    await all.ensure('')
  }

  /** Releitura explícita dos MCPs de um projeto (a tela do membro lê por `byProject`). */
  async function loadProject(projectId: string): Promise<void> {
    await byProject.refresh(projectId)
  }

  /**
   * Troca (ou acrescenta) o servidor gravado na lista. `previous`: a chave de antes (mudar de escopo muda a chave).
   * ⚖️ As listas do membro e as ferramentas do agente (`GET /tools`) mudam junto: as do membro são lidas de novo na
   * volta; as ferramentas, agora.
   */
  function put(server: IMcpServer, previous = server.key): void {
    all.update('', (current) => (current.some((one) => one.key === previous) ? current.map((one) => (one.key === previous ? server : one)) : [...current, server]))
    if (previous !== server.key) toolLists.drop(previous)
    byProject.clear()
  }

  function reloadAgentTools(): void {
    void useAgentsStore()
      .loadTools()
      .catch(() => undefined)
  }

  async function create(input: INewMcpServer): Promise<IMcpServer> {
    const created = await api<IMcpServer>('/mcp-servers', { method: 'POST', body: input })
    put(created)
    reloadAgentTools()
    return created
  }

  /** Devolve o servidor gravado: com `projectId` (ou `null`, global) ele muda de escopo — e de chave. */
  async function update(
    id: string,
    change: Partial<Pick<IMcpServer, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'identity' | 'enabled' | 'container' | 'process'>> & { projectId?: string | null },
  ): Promise<IMcpServer> {
    const saved = await api<IMcpServer>(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'PUT', body: change })
    put(saved, id)
    reloadAgentTools()
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/mcp-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
    all.update('', (current) => current.filter((one) => one.key !== id))
    toolLists.drop(id)
    byProject.clear()
    reloadAgentTools()
  }

  async function saveSecret(id: string, secret: string): Promise<void> {
    put(await api<IMcpServer>(`/mcp-servers/${encodeURIComponent(id)}/secret`, { method: 'PUT', body: { secret } }))
  }

  async function clearSecret(id: string): Promise<void> {
    put(await api<IMcpServer>(`/mcp-servers/${encodeURIComponent(id)}/secret`, { method: 'DELETE' }))
  }

  /** ⚖️ Testar é a releitura deliberada: o estado da conexão e as ferramentas, agora. */
  async function test(id: string): Promise<{ ok: boolean; tools: number; message?: string }> {
    const result = await api<{ ok: boolean; tools: number; message?: string }>(`/mcp-servers/${encodeURIComponent(id)}/test`, { method: 'POST' })
    await Promise.all([load(), loadTools(id)])
    return result
  }

  async function saveEnv(id: string, name: string, value: string): Promise<void> {
    put(await api<IMcpServer>(`/mcp-servers/${encodeURIComponent(id)}/env/${encodeURIComponent(name)}`, { method: 'PUT', body: { value } }))
  }

  /** A resposta só traz quantas pararam: o estado do servidor é relido. */
  async function stop(id: string): Promise<number> {
    const result = await api<{ stopped: number }>(`/mcp-servers/${encodeURIComponent(id)}/stop`, { method: 'POST' })
    await load()
    return result.stopped
  }

  /** `npm install` do pacote (pode levar minutos). `ok: false` traz o log do npm. */
  async function install(id: string): Promise<{ ok: boolean; version?: string; log: string }> {
    const { server, ...result } = await api<{ ok: boolean; version?: string; log: string; server?: IMcpServer }>(`/mcp-servers/${encodeURIComponent(id)}/install`, {
      method: 'POST',
    })
    if (server) put(server)
    else await load()
    return result
  }

  async function loadTools(id: string): Promise<IMcpTool[]> {
    return toolLists.refresh(id)
  }

  async function ensureTools(id: string): Promise<IMcpTool[]> {
    return toolLists.ensure(id)
  }

  /** Esquece o que é de quem estava logado (logout). */
  function reset(): void {
    all.clear()
    byProject.clear()
    toolLists.clear()
  }

  return {
    all,
    byProject,
    toolLists,
    list,
    loaded,
    tools,
    load,
    ensure,
    loadProject,
    create,
    update,
    remove,
    saveSecret,
    clearSecret,
    saveEnv,
    stop,
    install,
    test,
    loadTools,
    ensureTools,
    reset,
  }
})
