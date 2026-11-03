import { defineStore } from 'pinia'
import { computed } from 'vue'
import { api } from '@/lib/api'
import { keyedResource } from '@/lib/resource'
import type { ISchedule, IScheduleRun, TScheduleInput } from '@/lib/types'

/**
 * Os agendamentos de cada agente (só admin), por agente (`lists`, a chave é o id do agente); e a visão geral, por
 * projeto (`overview`, `''` = todos). A gravação põe a resposta na lista do agente; a visão geral é relida na volta.
 */
export const useSchedulesStore = defineStore('schedules', () => {
  const base = (agentId: string) => `/agents/${encodeURIComponent(agentId)}/schedules`
  const lists = keyedResource((agentId) => api<ISchedule[]>(base(agentId)))
  /** Todos, pela próxima execução; com `project`, os do projeto (os dos agentes dele e os globais que rodam nele). */
  const overview = keyedResource((project) => api<ISchedule[]>('/schedules', { query: project ? { project } : {} }))

  /** As listas já lidas, por agente. */
  const byAgent = computed<Record<string, ISchedule[]>>(() => Object.fromEntries(lists.keys().map((agentId) => [agentId, lists.get(agentId) ?? []])))

  /** Relê a lista do agente (a execução muda `lastRun`/`nextRun` por fora). */
  function load(agentId: string): Promise<ISchedule[]> {
    return lists.refresh(agentId)
  }

  function ensure(agentId: string): Promise<ISchedule[]> {
    return lists.ensure(agentId)
  }

  function all(project?: string): Promise<ISchedule[]> {
    return overview.ensure(project ?? '')
  }

  function put(agentId: string, schedule: ISchedule): void {
    lists.update(agentId, (list) => (list.some((one) => one.name === schedule.name) ? list.map((one) => (one.name === schedule.name ? schedule : one)) : [...list, schedule]))
    overview.clear()
  }

  async function create(agentId: string, input: TScheduleInput & { name: string }): Promise<ISchedule> {
    const created = await api<ISchedule>(base(agentId), { method: 'POST', body: input })
    put(agentId, created)
    return created
  }

  async function update(agentId: string, name: string, change: Partial<TScheduleInput>): Promise<void> {
    put(agentId, await api<ISchedule>(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'PUT', body: change }))
  }

  async function remove(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}`, { method: 'DELETE' })
    lists.update(agentId, (list) => list.filter((one) => one.name !== name))
    overview.clear()
  }

  /** Começa na hora; o andamento aparece no histórico. */
  async function runNow(agentId: string, name: string): Promise<void> {
    await api(`${base(agentId)}/${encodeURIComponent(name)}/run`, { method: 'POST' })
  }

  /** O histórico de execuções: muda enquanto a execução anda — lido na hora, não guardado. */
  async function runs(agentId: string, name: string): Promise<IScheduleRun[]> {
    return api<IScheduleRun[]>(`${base(agentId)}/${encodeURIComponent(name)}/runs`)
  }

  /** Esquece o que é de quem administrava (logout). */
  function reset(): void {
    lists.clear()
    overview.clear()
  }

  return { lists, overview, byAgent, load, ensure, all, create, update, remove, runNow, runs, reset }
})
