import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
import type { IAgent, IAgentDetail, IAgentInput, ITool } from '@/lib/types'

export const useAgentsStore = defineStore('agents', () => {
  const list = ref<IAgent[]>([])
  const tools = ref<ITool[]>([])
  const mcpConnected = ref(false)
  const loaded = ref(false)

  const byId = computed(() => new Map(list.value.map((agent) => [agent.id, agent])))

  async function load(): Promise<void> {
    list.value = await api<IAgent[]>('/agents')
    loaded.value = true
  }

  async function loadTools(): Promise<void> {
    const result = await api<{ mcp: { connected: boolean }; tools: ITool[] }>('/tools')
    tools.value = result.tools
    mcpConnected.value = result.mcp.connected
  }

  function detail(id: string): Promise<IAgentDetail> {
    return api<IAgentDetail>(`/agents/${encodeURIComponent(id)}`)
  }

  async function save(input: IAgentInput, creating: boolean): Promise<IAgentDetail> {
    const saved = creating
      ? await api<IAgentDetail>('/agents', { method: 'POST', body: input })
      : await api<IAgentDetail>(`/agents/${encodeURIComponent(input.id ?? '')}`, { method: 'PUT', body: input })
    await load()
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  return { list, tools, mcpConnected, loaded, byId, load, loadTools, detail, save, remove }
})
