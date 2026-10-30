import { makeSecretMasker } from './SecretMask.Factory'
import { ResumeSessionUseCase } from '@application/ResumeSession.Usecase'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { TurnLive } from '@infra/events/Turn.Live'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { makeClassifier } from './Classifier.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { makeOrchestrator } from './Orchestrator.Factory'
import { makeTools } from './Tools.Factory'
import { makeAgents } from './Agents.Factory'
import { DelegationService } from '@application/Delegation.Service'

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  // Toda escrita passa pelo decorador, que avisa a caixa de entrada; a leitura vai direto.
  const events = new InMemoryConversationEvents()
  const conversations = new NotifyingConversationRepository(makeConversationRepository(), events)

  // O turno ao vivo avisa a mesma caixa de entrada (quem está rodando).
  const live = new TurnLive(events)

  const createSession = new CreateSessionUseCase(agentProvider)
  const sendMessage = new SendMessageUseCase(agentProvider, conversations, makeClassifier(), makeSecretMasker(), live)
  // A delegação usa os MESMOS casos de uso: a conversa filha é gravada e avisada como qualquer outra.
  makeTools().delegation.bind(new DelegationService(agentProvider, createSession, sendMessage, undefined, (id) => makeAgents().get(id)?.modes))
  // Os MCPs em contêiner leem a conversa (agente e `metadata`) para os domínios `{meta:…}` e para o proxy.
  makeTools().mcp.setSessionLookup((id) => {
    try {
      return agentProvider.describe(id)
    } catch {
      return undefined
    }
  })

  return {
    /** O MESMO repositório do `SendMessageUseCase`: o controller lê o que ele grava. */
    conversations,
    /** O MESMO barramento em que o repositório publica: a rota SSE assina este. */
    events,
    /** O MESMO barramento em que o `SendMessageUseCase` publica o turno: a rota `/live` assina este. */
    live,
    createSessionUseCase: createSession,
    sendMessageUseCase: sendMessage,
    cancelSessionUseCase: new CancelSessionUseCase(agentProvider),
    reconfigureSessionUseCase: new ReconfigureSessionUseCase(agentProvider),
    deleteSessionUseCase: new DeleteSessionUseCase(agentProvider),
    getSessionUseCase: new GetSessionUseCase(agentProvider),
    listSessionsUseCase: new ListSessionsUseCase(agentProvider),
    resumeSessionUseCase: new ResumeSessionUseCase(agentProvider, conversations),
  }
}
