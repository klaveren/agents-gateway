import { AgentController } from '@infra/http/Agent.Controller'
import { makeTools } from './Tools.Factory'
import { proofFromEnv } from '@infra/http/Caller.Proof'
import { sessionContextFromEnv } from '@infra/session/Template.SessionContext'
import { makeSettings } from './Settings.Factory'
import { makeUsecases } from './Usecases.Factory'

export function makeController(): AgentController {
  const usecases = makeUsecases()
  const { catalog } = makeTools()

  return new AgentController({
    catalog,
    proof: proofFromEnv(catalog),
    settings: makeSettings(),
    sessionContext: sessionContextFromEnv(),
    createSession: usecases.createSessionUseCase,
    sendMessage: usecases.sendMessageUseCase,
    cancelSession: usecases.cancelSessionUseCase,
    deleteSession: usecases.deleteSessionUseCase,
    getSession: usecases.getSessionUseCase,
    listSessions: usecases.listSessionsUseCase,
  })
}
