import { TClassification } from '@domain/models/Classification.Model'
import { IConversationPage, IConversationSession, IConversationStats, IConversationTurn } from '@domain/models/Conversation.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'

/**
 * O repositório que não guarda nada — o que vale enquanto não há banco plugado.
 *
 * ⚖️ Mesma escolha que o gateway já faz com o MCP: sem servidor configurado ele não quebra, só
 * oferece menos. Sem banco a conversa continua acontecendo e o histórico simplesmente não existe —
 * que é exatamente o comportamento de antes desta camada, e o certo para quem sobe o gateway para
 * testar um provider sem querer infraestrutura junto.
 *
 * ⚖️ Objeto nulo em vez de `if (repo)` espalhado: quem chama não precisa saber se há banco, e não
 * há um segundo caminho de código que só roda em produção — que é onde os defeitos se escondem.
 */
export class NullConversationRepository implements IConversationRepository {
  async saveSession(_session: IConversationSession): Promise<void> {}
  async appendTurn(_turn: IConversationTurn): Promise<number | undefined> {
    return undefined
  }
  async classifyTurn(_sessionId: string, _index: number, _classification: TClassification): Promise<void> {}
  async listSessions(): Promise<IConversationSession[]> {
    return []
  }
  async pageSessions(): Promise<IConversationPage> {
    return { sessions: [], total: 0, facets: { classification: {}, provider: {}, agent: {} } }
  }
  async listTurns(): Promise<IConversationTurn[]> {
    return []
  }
  async findSession(): Promise<undefined> {
    return undefined
  }
  async setShared(_sessionId: string, _shared: boolean, _shareId?: string): Promise<void> {}
  async findByShareId(): Promise<undefined> {
    return undefined
  }
  async deleteSession(_sessionId: string): Promise<void> {}
  async stats(): Promise<IConversationStats> {
    return { conversations: 0, turns: 0, users: 0, accounts: 0, usage: {}, byModel: [], byClassification: {} }
  }
}
