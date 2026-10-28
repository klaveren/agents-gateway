import { IAgentSchedule, IScheduleRun } from '@domain/models/AgentSchedule.Model'

export type TSchedulePatch = Partial<Omit<IAgentSchedule, 'agentId' | 'name' | 'createdAt' | 'runAs'>>

/** Os agendamentos dos agentes e o histórico das execuções. Síncrono, como o resto do cadastro. */
export interface IAgentScheduleRepository {
  /** Todos, ou os de um agente, pelo nome. */
  list(agentId?: string): IAgentSchedule[]
  get(agentId: string, name: string): IAgentSchedule | undefined
  insert(schedule: IAgentSchedule): void
  update(agentId: string, name: string, patch: TSchedulePatch): IAgentSchedule | undefined
  delete(agentId: string, name: string): boolean
  /** O agente foi apagado: os agendamentos e as execuções dele vão junto. */
  deleteAgent(agentId: string): void

  /** As execuções, as mais recentes primeiro (só as `SCHEDULE_RUNS_KEPT` últimas ficam). */
  runs(agentId: string, name: string): IScheduleRun[]
  addRun(run: IScheduleRun): void
  updateRun(id: string, patch: Partial<Omit<IScheduleRun, 'id' | 'agentId' | 'scheduleName'>>): void
}
