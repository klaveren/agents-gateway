import { AgentController } from '@infra/http/Agent.Controller'
import { makeTools } from './Tools.Factory'
import { makeUsecases } from './Usecases.Factory'

export function makeController(): AgentController {
  const usecases = makeUsecases()

  return new AgentController({
    catalog: makeTools().catalog,
    createSession: usecases.createSessionUseCase,
    sendMessage: usecases.sendMessageUseCase,
    cancelSession: usecases.cancelSessionUseCase,
    deleteSession: usecases.deleteSessionUseCase,
    getSession: usecases.getSessionUseCase,
    listSessions: usecases.listSessionsUseCase,
  })
}
