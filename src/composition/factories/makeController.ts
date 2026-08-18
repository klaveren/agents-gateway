import { AgentController } from '@application/Agent.Controller'
import { makeUsecases } from './makeUsecases'

export function makeController(): AgentController {
  const { createSessionUseCase, sendMessageUseCase, cancelSessionUseCase } = makeUsecases()
  return new AgentController(createSessionUseCase, sendMessageUseCase, cancelSessionUseCase)
}
