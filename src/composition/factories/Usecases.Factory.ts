import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { SqliteConversationRepository, DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { makeClassifier } from './Classifier.Factory'
import { makeOrchestrator } from './Orchestrator.Factory'
import { makeTools } from './Tools.Factory'
import { makeAgents } from './Agents.Factory'
import { DelegationService } from '@application/Delegation.Service'

/**
 * Onde a conversa é gravada.
 *
 * ⚖️ GRAVA POR PADRÃO. O arquivo é criado sozinho e não custa nada; exigir configuração para
 * registrar faria toda instalação nova rodar sem histórico, e ninguém descobre que falta registro
 * pelo sintoma — descobre no dia em que precisa olhar para trás e não tem o quê.
 *
 * `CONVERSATIONS_DB=off` desliga; qualquer outro valor é o caminho do arquivo.
 *
 * ⚠️ O script `test` do package.json força `:memory:`. Sem isso a suíte grava um `data/gateway.db`
 * de verdade no repositório — três testes montam esta factory, e um teste que deixa arquivo para
 * trás é um teste que muda de resultado conforme a ordem em que roda.
 */
export function makeConversationRepository() {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  if (configured === 'off') return new NullConversationRepository()

  try {
    return new SqliteConversationRepository(configured || DEFAULT_DB_PATH)
  } catch (error) {
    // ⛔ Não poder gravar não pode impedir o gateway de atender. Disco cheio, permissão negada,
    // caminho inválido: segue sem histórico, dizendo por quê.
    console.warn('[sqlite] não foi possível abrir o banco; seguindo sem registrar conversa.', error)
    return new NullConversationRepository()
  }
}

export function makeUsecases() {
  const agentProvider = makeOrchestrator()

  // Toda escrita passa pelo decorador, que avisa a caixa de entrada; a leitura vai direto.
  const events = new InMemoryConversationEvents()
  const conversations = new NotifyingConversationRepository(makeConversationRepository(), events)

  const createSession = new CreateSessionUseCase(agentProvider)
  const sendMessage = new SendMessageUseCase(agentProvider, conversations, makeClassifier())
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
    createSessionUseCase: createSession,
    sendMessageUseCase: sendMessage,
    cancelSessionUseCase: new CancelSessionUseCase(agentProvider),
    reconfigureSessionUseCase: new ReconfigureSessionUseCase(agentProvider),
    deleteSessionUseCase: new DeleteSessionUseCase(agentProvider),
    getSessionUseCase: new GetSessionUseCase(agentProvider),
    listSessionsUseCase: new ListSessionsUseCase(agentProvider),
  }
}
