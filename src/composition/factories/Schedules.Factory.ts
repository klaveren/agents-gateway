import { AgentSchedulesService } from '@application/AgentSchedules.Service'
import { ScheduleRunner } from '@application/Schedule.Runner'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteAgentScheduleRepository } from '@infra/persistence/Sqlite.AgentScheduleRepository'
import { makeScheduleExecutor } from '@infra/schedule/Schedule.Executor'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeProjects } from './Projects.Factory'
import { selfUrl } from './Tools.Factory'

let service: AgentSchedulesService | undefined
let runner: ScheduleRunner | undefined

/** Os agendamentos dos agentes: UM serviço, no mesmo arquivo das conversas (o controller, o relógio e a remoção do agente o dividem). */
export function makeSchedules(): AgentSchedulesService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  service = new AgentSchedulesService(
    new SqliteAgentScheduleRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    (agentId) => {
      const agent = makeAgents().get(agentId)
      return agent ? { id: agent.id, ...(agent.projectId ? { projectId: agent.projectId } : {}) } : undefined
    },
    (projectId) => makeProjects().exists(projectId),
  )
  return service
}

/** O relógio dos agendamentos: executa pela API deste processo, em nome de quem criou cada um. */
export function makeScheduleRunner(): ScheduleRunner {
  if (runner) return runner
  const schedules = makeSchedules()
  runner = new ScheduleRunner(
    schedules,
    makeScheduleExecutor({
      base: () => selfUrl().replace(/\/mcp$/, ''),
      sessionFor: (userId) => makeAuth().accounts?.sessionForHook(userId),
      setSession: (schedule, sessionId) => schedules.setSession(schedule, sessionId),
    }),
  )
  return runner
}
