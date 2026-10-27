import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { IAgentHook, IHookDelivery, THookInput } from '@/lib/types'

/** Os hooks de cada agente (só admin), lidos por agente. ⛔ A chave só vem em `create` e `rotate`. */
export const useHooksStore = defineStore('hooks', () => {
  const byAgent = ref<Record<string, IAgentHook[]>>({})
  const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/hooks`

  async function load(agentId: string): Promise<IAgentHook[]> {
    const list = await api<IAgentHook[]>(base(agentId))
    byAgent.value = { ...byAgent.value, [agentId]: list }
    return list
  }

  async function create(agentId: string, input: THookInput & { name: string }): Promise<IAgentHook> {
    const created = await api<IAgentHook>(base(agentId), { method: 'POST', body: input })
    await load(agentId)
    return created
  }

  async function update(agentId: string, name: string, change: Partial<THookInput>): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'PUT', body: change })
    await load(agentId)
  }

  async function remove(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await load(agentId)
  }

  async function rotate(agentId: string, name: string): Promise<IAgentHook> {
    const rotated = await api<IAgentHook>(`${base(agentId)}/${encodeURIComponent(name)}/rotate`, { method: 'POST' })
    await load(agentId)
    return rotated
  }

  async function deliveries(agentId: string, name: string): Promise<IHookDelivery[]> {
    return api<IHookDelivery[]>(`${base(agentId)}/${encodeURIComponent(name)}/deliveries`)
  }

  return { byAgent, load, create, update, remove, rotate, deliveries }
})
