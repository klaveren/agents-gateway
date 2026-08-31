import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { makeOrchestrator } from './Orchestrator.Factory'

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  /**
   * Sem banco plugado, a conversa não é guardada (ver `NullConversationRepository`). Trocar por um
   * repositório de verdade é trocar esta linha — o `schema.sql` na raiz tem a estrutura mínima.
   */
  const conversations = new NullConversationRepository()

  return {
    createSessionUseCase: new CreateSessionUseCase(agentProvider),
    sendMessageUseCase: new SendMessageUseCase(agentProvider, conversations),
    cancelSessionUseCase: new CancelSessionUseCase(agentProvider),
    deleteSessionUseCase: new DeleteSessionUseCase(agentProvider),
    getSessionUseCase: new GetSessionUseCase(agentProvider),
    listSessionsUseCase: new ListSessionsUseCase(agentProvider),
  }
}
