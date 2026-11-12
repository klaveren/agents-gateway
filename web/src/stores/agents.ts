import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IAgent, IAgentDetail, IAgentInput, ICapability, INativeTool, ITool, TImportIssueMatch } from '@/lib/types'
import { issueMatch } from './docs'
import type { IResourceFile } from '@/lib/resourceFiles'
import { useProjectsStore } from './projects'

interface IToolsResult {
  mcp: { connected: boolean }
  tools: ITool[]
  capabilities?: ICapability[]
  native?: INativeTool[]
  limits?: { delegationMaxDepth: number }
}

/**
 * Os agentes: a lista POR PROJETO (`lists`, a chave é o projeto; `''` sem projeto), o agente inteiro de cada um
 * (`details`, só admin) e as ferramentas do servidor (`GET /tools`). `list`/`loaded` são os do projeto atual.
 * ⚖️ `load()` relê a lista do projeto atual (ela traz `unavailable`, que muda por fora); `ensure()` só lê se não tem.
 */
/** As ferramentas de vigia na linha do turno: o que o agente fez, não o nome da ferramenta. */
const WATCH_LABELS: Record<string, string> = {
  watch_start: 'Armou uma vigia',
  wake_me: 'Armou um despertador',
  watch_list: 'Conferiu as vigias',
  watch_stop: 'Cancelou uma vigia',
}

export const useAgentsStore = defineStore('agents', () => {
  // Os do projeto e os globais (o Atlas).
  const lists = keyedResource((project) => api<IAgent[]>('/agents', { query: project ? { project } : {} }))
  const details = keyedResource((id) => api<IAgentDetail>(`/agents/${encodeURIComponent(id)}`))
  const toolsResource = keyedResource(() => api<IToolsResult>('/tools'))

  const listKey = computed(() => useProjectsStore().current ?? '')
  const list = computed<IAgent[]>({
    get: () => lists.get(listKey.value) ?? [],
    set: (value) => lists.set(listKey.value, value),
  })
  const loaded = computed(() => lists.has(listKey.value))

  const toolsResult = computed(() => toolsResource.get(''))
  const tools = computed(() => toolsResult.value?.tools ?? [])
  const capabilities = computed(() => toolsResult.value?.capabilities ?? [])
  const nativeTools = computed(() => toolsResult.value?.native ?? [])
  const mcpConnected = computed(() => toolsResult.value?.mcp.connected ?? false)
  /** Limites do servidor que a tela cita em texto (`GET /tools`). */
  const limits = computed(() => toolsResult.value?.limits ?? { delegationMaxDepth: 2 })
  const toolsLoaded = computed(() => toolsResource.has(''))

  const byId = computed(() => new Map(list.value.map((agent) => [agent.id, agent])))
  /** Os que abrem conversa: subagente só é chamado por outro agente. */
  const conversable = computed(() => list.value.filter((agent) => agent.role !== 'subagent'))

  async function load(): Promise<void> {
    await lists.refresh(listKey.value)
  }

  async function ensure(): Promise<void> {
    await lists.ensure(listKey.value)
  }

  async function loadTools(): Promise<void> {
    await toolsResource.refresh('')
  }

  async function ensureTools(): Promise<void> {
    await toolsResource.ensure('')
  }

  /** O agente inteiro (com o prompt): o guardado, ou lido uma vez. */
  function detail(id: string): Promise<IAgentDetail> {
    return details.ensure(id)
  }

  async function save(input: IAgentInput, creating: boolean): Promise<IAgentDetail> {
    const saved = creating
      ? await api<IAgentDetail>('/agents', { method: 'POST', body: input })
      : await api<IAgentDetail>(`/agents/${encodeURIComponent(input.id ?? '')}`, { method: 'PUT', body: input })
    details.set(saved.id, saved)
    // ⚖️ A lista traz `unavailable`, que a resposta não traz: relê a do projeto atual.
    // ⚠️ Já gravou: falha ao reler a lista não pode virar "não salvou".
    await reloadLists().catch(() => undefined)
    return saved
  }

  /**
   * A guia Compartilhar: grava a lista INTEIRA de projetos. ⚖️ Como em `saveFiles`: troca só o `sharedWith` no detalhe
   * guardado, no MESMO objeto (o formulário aberto não se refaz); as listas dos outros projetos são esquecidas.
   */
  async function share(id: string, projects: string[]): Promise<IAgentDetail> {
    const saved = await api<IAgentDetail>(`/agents/${encodeURIComponent(id)}/shares`, { method: 'PUT', body: { projects } })
    details.update(id, (current) => Object.assign(current, { sharedWith: saved.sharedWith ?? projects }))
    for (const key of lists.keys()) if (key !== listKey.value) lists.drop(key)
    return saved
  }

  /** Relê a lista do projeto atual; as dos outros projetos são esquecidas e lidas na volta a eles. */
  async function reloadLists(): Promise<void> {
    for (const key of lists.keys()) if (key !== listKey.value) lists.drop(key)
    await load()
  }

  /**
   * Mudou o que vale para TODOS os agentes (um provider, um modelo ligado): as listas e os detalhes guardados
   * (`disabledModels`, o nome do provider) ficam velhos. Relê a lista atual; os detalhes, quando abertos de novo.
   */
  async function reloadAll(): Promise<void> {
    details.clear()
    await reloadLists()
  }

  async function remove(id: string): Promise<void> {
    await api(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
    for (const key of lists.keys()) lists.update(key, (current) => current.filter((agent) => agent.id !== id))
    details.drop(id)
  }

  /**
   * Os arquivos da pasta do agente (guia própria, gravada à parte). ⚖️ Troca só os arquivos no detalhe guardado, no
   * MESMO objeto: o formulário aberto não se refaz (perderia o que ainda não foi salvo), e quem abrir depois já os vê.
   */
  /** `base`: os caminhos que a guia mostrava — o que ela tirou sai da pasta; o que o agente gravou depois, fica. */
  async function saveFiles(id: string, files: IResourceFile[], base: readonly string[] = []): Promise<void> {
    await api(`/agents/${encodeURIComponent(id)}/files`, { method: 'PUT', body: { files, base } })
    const current = details.get(id)
    if (current) current.files = files
  }

  /**
   * As regras do agente mudaram por fora do formulário (um pedido de permissão aprovado). ⚖️ Como em `saveFiles`: troca
   * só as regras no detalhe guardado, no MESMO objeto — o formulário aberto não se refaz.
   */
  function setPermissions(id: string, permissions: IAgentDetail['permissions']): void {
    const current = details.get(id)
    if (current) current.permissions = permissions
  }

  /**
   * "Resolvido" num problema da importação do agente. ⚖️ Como em `saveFiles`: troca só a lista no detalhe guardado, no
   * MESMO objeto (o formulário aberto não se refaz), e a contagem na lista.
   */
  async function resolveIssue(id: string, issue: TImportIssueMatch): Promise<IAgentDetail> {
    const saved = await api<IAgentDetail>(`/agents/${encodeURIComponent(id)}/import-issues/resolve`, { method: 'POST', body: issueMatch(issue) })
    details.update(id, (current) => Object.assign(current, { importIssues: saved.importIssues }))
    for (const key of lists.keys()) lists.update(key, (list) => list.map((agent) => (agent.id === id ? { ...agent, importIssueCount: saved.importIssues?.length } : agent)))
    return saved
  }

  /** Esquece o que é de quem estava logado (as listas e os detalhes; as ferramentas são relidas no novo escopo). */
  function reset(): void {
    lists.clear()
    details.clear()
  }

  /** O nome legível de uma ferramenta no histórico: o rótulo da nativa (`WebSearch` → "Busca na web"), senão o próprio nome. */
  function toolLabel(name: string): string {
    // `…_call`: como as conversas gravadas antes da normalização guardaram as hospedadas da OpenAI.
    const base = name.replace(/_call$/, '')
    if (base === 'update_todos' || base.endsWith('__update_todos')) return 'Atualizou as tarefas'
    const watch = WATCH_LABELS[base.split('__').pop() ?? '']
    if (watch) return watch
    return nativeTools.value.find((tool) => tool.sdkName === name || tool.sdkName === base)?.label ?? name
  }

  return {
    lists,
    details,
    list,
    conversable,
    tools,
    capabilities,
    nativeTools,
    mcpConnected,
    limits,
    toolsLoaded,
    toolLabel,
    loaded,
    byId,
    load,
    ensure,
    reloadLists,
    reloadAll,
    loadTools,
    ensureTools,
    detail,
    save,
    remove,
    saveFiles,
    share,
    setPermissions,
    resolveIssue,
    reset,
  }
})
