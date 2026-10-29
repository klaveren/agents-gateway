import { TScheduleExecutor } from '@application/Schedule.Runner'
import { IAgentSchedule } from '@domain/models/AgentSchedule.Model'
import { selfApi } from '@infra/http/Self.Api'
import { openConversation, runTurn } from '@infra/http/Self.Run'

export interface IScheduleExecutorDeps {
  /** A base da API deste processo (`http://127.0.0.1:<porta>/v1`). */
  base: () => string
  /** Uma sessão curta da conta, se ela ainda está ativa — é em nome dela que o agendamento roda. */
  sessionFor: (userId: string) => { token: string } | undefined
  /** Grava a conversa de um agendamento contínuo. */
  setSession: (schedule: IAgentSchedule, sessionId: string) => void
}

/**
 * Executa um agendamento pela API do gateway, em nome de quem o criou: abre a conversa (ou continua a do agendamento
 * contínuo — a sessão expirada é retomada pela própria API) e manda o texto, que pode ser um `/command`.
 */
export function makeScheduleExecutor(deps: IScheduleExecutorDeps): TScheduleExecutor {
  return async (schedule) => {
    const session = deps.sessionFor(schedule.runAs)
    if (!session) return { error: 'The account this schedule runs as is disabled or gone; recreate the schedule' }
    const base = deps.base()
    const credentials = { 'x-tool-authorization': `Bearer ${session.token}` }
    const api = selfApi(base, credentials)

    if (schedule.session === 'continuous' && schedule.sessionId) {
      const error = await runTurn(base, credentials, schedule.sessionId, schedule.prompt)
      // A conversa foi apagada: começa outra (e a grava); qualquer outro erro é da execução.
      if (!error || !/not found/i.test(error)) return { sessionId: schedule.sessionId, ...(error ? { error } : {}) }
    }
    const sessionId = await openConversation(api, {
      agentId: schedule.agentId,
      ...(schedule.projectId ? { projectId: schedule.projectId } : {}),
      metadata: { schedule: { agentId: schedule.agentId, name: schedule.name } },
    })
    if (schedule.session === 'continuous') deps.setSession(schedule, sessionId)
    const error = await runTurn(base, credentials, sessionId, schedule.prompt)
    return { sessionId, ...(error ? { error } : {}) }
  }
}
