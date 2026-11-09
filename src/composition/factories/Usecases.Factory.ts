import { makeSecretMasker } from './SecretMask.Factory'
import { ResumeSessionUseCase } from '@application/ResumeSession.Usecase'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { UsageCapService } from '@application/UsageCap.Service'
import { makeModelCatalog } from './Catalog.Factory'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { TurnLive } from '@infra/events/Turn.Live'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { makeClassifier } from './Classifier.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { makeOrchestrator } from './Orchestrator.Factory'
import { makeTools } from './Tools.Factory'
import { makeAgents } from './Agents.Factory'
import { DelegationService } from '@application/Delegation.Service'
import { backgroundProcesses } from '@infra/tools/Background.Processes'

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  // Toda escrita passa pelo decorador, que avisa a caixa de entrada; a leitura vai direto.
  const events = new InMemoryConversationEvents()
  const conversations = new NotifyingConversationRepository(makeConversationRepository(), events)

  // O turno ao vivo avisa a mesma caixa de entrada (quem está rodando).
  const live = new TurnLive(events)

  const createSession = new CreateSessionUseCase(agentProvider)
  // O teto de uso do mês: as linhas da tela Uso, precificadas pelo catálogo na hora (o catálogo lê os agentes ao nascer).
  const usageCap = new UsageCapService(
    (query) => conversations.usage(query),
    (provider) => makeModelCatalog().pricing(provider),
  )
  const sendMessage = new SendMessageUseCase(agentProvider, conversations, makeClassifier(), makeSecretMasker(), live, usageCap)
  // A delegação usa os MESMOS casos de uso: a conversa filha é gravada e avisada como qualquer outra.
  makeTools().delegation.bind(
    new DelegationService(
      agentProvider,
      createSession,
      sendMessage,
      undefined,
      (id) => makeAgents().get(id)?.modes,
      // A filha encerrada volta pelo histórico, como a conversa da tela: só a desta mãe (o provider confere de novo).
      async (sessionId, parentId) => {
        const stored = await conversations.findSession(sessionId)
        if (!stored) return undefined
        const delegatedBy = stored.metadata?.delegatedBy
        if (delegatedBy !== parentId) return { agentId: stored.agentId, delegatedBy }
        // ⛔ Arquivada não volta sozinha: quem arquivou decide (desarquiva pela tela).
        if (stored.archivedAt) throw new Error('the conversation is archived; unarchive it on the screen to continue')
        const [turns, native] = await Promise.all([conversations.listTurns(sessionId), conversations.findNative?.(sessionId)])
        await agentProvider.resume?.({ session: stored, turns, delegatedBy: parentId, ...(native ? { native } : {}) })
        return { agentId: stored.agentId, delegatedBy }
      },
      // A filha sai da memória quando para: com processo em segundo plano dela rodando, ou outro turno já em curso, fica.
      (sessionId) => {
        try {
          if (agentProvider.describe(sessionId).status === 'running' || backgroundProcesses().running(sessionId).length) return
        } catch {
          return
        }
        void agentProvider.dispose(sessionId).catch(() => undefined)
      },
    ),
  )
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
    /** O MESMO teto que trava o turno: a tela Uso mostra o consumo contra ele. */
    usageCap,
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
