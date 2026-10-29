import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { ISchedule, IScheduleRun, TScheduleInput } from '@/lib/types'

/** Os agendamentos de cada agente (só admin), lidos por agente; e a visão geral, por projeto. */
export const useSchedulesStore = defineStore('schedules', () => {
  const byAgent = ref<Record<string, ISchedule[]>>({})
  const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/schedules`

  async function load(agentId: string): Promise<ISchedule[]> {
    const list = await api<ISchedule[]>(base(agentId))
    byAgent.value = { ...byAgent.value, [agentId]: list }
    return list
  }

  /** Todos, pela próxima execução; com `project`, os do projeto (os dos agentes dele e os globais que rodam nele). */
  async function all(project?: string): Promise<ISchedule[]> {
    return api<ISchedule[]>('/schedules', { query: project ? { project } : {} })
  }

  async function create(agentId: string, input: TScheduleInput & { name: string }): Promise<ISchedule> {
    const created = await api<ISchedule>(base(agentId), { method: 'POST', body: input })
    await load(agentId)
    return created
  }

  async function update(agentId: string, name: string, change: Partial<TScheduleInput>): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'PUT', body: change })
    await load(agentId)
  }

  async function remove(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    await load(agentId)
  }

  /** Começa na hora; o andamento aparece no histórico. */
  async function runNow(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}/run`, { method: 'POST' })
  }

  async function runs(agentId: string, name: string): Promise<IScheduleRun[]> {
    return api<IScheduleRun[]>(`${base(agentId)}/${encodeURIComponent(name)}/runs`)
  }

  return { byAgent, load, all, create, update, remove, runNow, runs }
})
