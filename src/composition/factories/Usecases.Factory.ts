import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { makeOrchestrator } from './Orchestrator.Factory'

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  return {
    createSessionUseCase: new CreateSessionUseCase(agentProvider),
    sendMessageUseCase: new SendMessageUseCase(agentProvider),
    cancelSessionUseCase: new CancelSessionUseCase(agentProvider),
    deleteSessionUseCase: new DeleteSessionUseCase(agentProvider),
    getSessionUseCase: new GetSessionUseCase(agentProvider),
    listSessionsUseCase: new ListSessionsUseCase(agentProvider),
  }
}
