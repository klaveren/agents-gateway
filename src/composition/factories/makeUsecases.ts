import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { makeOrchestrator } from './makeOrchestrator'

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  return {
    createSessionUseCase: new CreateSessionUseCase(agentProvider),
    sendMessageUseCase: new SendMessageUseCase(agentProvider),
    cancelSessionUseCase: new CancelSessionUseCase(agentProvider),
  }
}
