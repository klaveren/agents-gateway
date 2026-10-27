import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import type { IAgent, IAgentDetail, IAgentInput, INativeTool, ITool } from '@/lib/types'
import { useProjectsStore } from './projects'

export const useAgentsStore = defineStore('agents', () => {
  const list = ref<IAgent[]>([])
  const tools = ref<ITool[]>([])
  const nativeTools = ref<INativeTool[]>([])
  const mcpConnected = ref(false)
  /** Limites do servidor que a tela cita em texto (`GET /tools`). */
  const limits = ref<{ delegationMaxDepth: number }>({ delegationMaxDepth: 2 })
  const toolsLoaded = ref(false)
  const loaded = ref(false)

  const byId = computed(() => new Map(list.value.map((agent) => [agent.id, agent])))
  /** Os que abrem conversa: subagente só é chamado por outro agente. */
  const conversable = computed(() => list.value.filter((agent) => agent.role !== 'subagent'))

  async function load(): Promise<void> {
    // Os do projeto atual e os globais (o Atlas).
    list.value = await api<IAgent[]>('/agents', { query: useProjectsStore().query })
    loaded.value = true
  }

  async function loadTools(): Promise<void> {
    const result = await api<{ mcp: { connected: boolean }; tools: ITool[]; native?: INativeTool[]; limits?: { delegationMaxDepth: number } }>('/tools')
    tools.value = result.tools
    nativeTools.value = result.native ?? []
    mcpConnected.value = result.mcp.connected
    if (result.limits) limits.value = result.limits
    toolsLoaded.value = true
  }

  function detail(id: string): Promise<IAgentDetail> {
    return api<IAgentDetail>(`/agents/${encodeURIComponent(id)}`)
  }

  async function save(input: IAgentInput, creating: boolean): Promise<IAgentDetail> {
    const saved = creating
      ? await api<IAgentDetail>('/agents', { method: 'POST', body: input })
      : await api<IAgentDetail>(`/agents/${encodeURIComponent(input.id ?? '')}`, { method: 'PUT', body: input })
    // ⚠️ Já gravou: falha ao reler a lista não pode virar "não salvou".
    await load().catch(() => undefined)
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load().catch(() => undefined)
  }

  /** O nome legível de uma ferramenta no histórico: o rótulo da nativa (`WebSearch` → "Busca na web"), senão o próprio nome. */
  function toolLabel(name: string): string {
    // `…_call`: como as conversas gravadas antes da normalização guardaram as hospedadas da OpenAI.
    const base = name.replace(/_call$/, '')
    return nativeTools.value.find((tool) => tool.sdkName === name || tool.sdkName === base)?.label ?? name
  }

  return { list, conversable, tools, nativeTools, mcpConnected, limits, toolsLoaded, toolLabel, loaded, byId, load, loadTools, detail, save, remove }
})
