import { defineStore } from 'pinia'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { IAgentHook, IHookDelivery, THookInput } from '@/lib/types'

/**
 * Os hooks de cada agente (só admin), por agente (`lists`, a chave é o id do agente). A gravação põe a resposta do
 * servidor na lista, sem reler. ⛔ A chave só vem em `create` e `rotate`, e NUNCA fica na store: quem chama a mostra
 * uma vez.
 */
export const useHooksStore = defineStore('hooks', () => {
  const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/hooks`
  const lists = keyedResource((agentId) => api<IAgentHook[]>(base(agentId)))

  /** Troca (ou acrescenta) o hook na lista do agente, sem a chave. */
  function put(agentId: string, hook: IAgentHook): void {
    const { secret: _secret, ...kept } = hook
    lists.update(agentId, (list) => (list.some((one) => one.name === kept.name) ? list.map((one) => (one.name === kept.name ? kept : one)) : [...list, kept]))
  }

  async function create(agentId: string, input: THookInput & { name: string }): Promise<IAgentHook> {
    const created = await api<IAgentHook>(base(agentId), { method: 'POST', body: input })
    put(agentId, created)
    return created
  }

  async function update(agentId: string, name: string, change: Partial<THookInput>): Promise<void> {
    put(agentId, await api<IAgentHook>(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'PUT', body: change }))
  }

  async function remove(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    lists.update(agentId, (list) => list.filter((one) => one.name !== name))
  }

  async function rotate(agentId: string, name: string): Promise<IAgentHook> {
    const rotated = await api<IAgentHook>(`${base(agentId)}/${encodeURIComponent(name)}/rotate`, { method: 'POST' })
    put(agentId, rotated)
    return rotated
  }

  /** As entregas de um hook: um histórico que muda a cada chamada de fora — lido na hora, não guardado. */
  async function deliveries(agentId: string, name: string): Promise<IHookDelivery[]> {
    return api<IHookDelivery[]>(`${base(agentId)}/${encodeURIComponent(name)}/deliveries`)
  }

  return { lists, create, update, remove, rotate, deliveries }
})
