import { TClassification } from '@domain/models/Classification.Model'
import { IConversationPage, IConversationPageQuery, IConversationSession, IConversationStats, IConversationTurn, IOwnerFilter } from '@domain/models/Conversation.Model'
import { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'
import { IConversationEvents } from '@domain/ports/ConversationEvents.Port'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'

/**
 * O repositório que AVISA: grava no de verdade e, depois, publica o que mudou.
 *
 * ⚖️ DECORADOR, e não o use case publicando: toda escrita passa por aqui — o turno, o rótulo que
 * chega depois, o compartilhar e o apagar da tela —, e quem esquecesse de publicar num desses
 * deixaria a caixa de entrada desatualizada sem nenhum erro à vista.
 *
 * ⚠️ `saveSession` NÃO publica: o cabeçalho é regravado logo antes de cada `appendTurn`, e avisar
 * os dois mandaria a mesma linha duas vezes por turno — a primeira ainda sem a prévia nova.
 *
 * ⛔ PUBLICAR NUNCA DERRUBA A ESCRITA. A releitura que monta o evento é a mesma do repositório, que
 * já engole o próprio erro; o barramento isola os ouvintes.
 */
export class NotifyingConversationRepository implements IConversationRepository {
  constructor(
    private readonly inner: IConversationRepository,
    private readonly events: IConversationEvents,
  ) {}

  saveSession(session: IConversationSession): Promise<void> {
    return this.inner.saveSession(session)
  }

  async appendTurn(turn: IConversationTurn): Promise<number | undefined> {
    const stored = await this.inner.appendTurn(turn)
    if (stored !== undefined) await this.announce(turn.sessionId)

    return stored
  }

  async classifyTurn(sessionId: string, index: number, classification: TClassification): Promise<void> {
    await this.inner.classifyTurn(sessionId, index, classification)
    await this.announce(sessionId)
  }

  async setShared(sessionId: string, shared: boolean, shareId?: string): Promise<void> {
    await this.inner.setShared(sessionId, shared, shareId)
    await this.announce(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Lido ANTES: depois de apagar não há mais de quem era.
    const before = await this.inner.findSession(sessionId)
    await this.inner.deleteSession(sessionId)

    if (before) this.events.publish({ type: 'conversation.deleted', sessionId, metadata: before.metadata })
  }

  stats(): Promise<IConversationStats> {
    return this.inner.stats()
  }

  usage(query: IUsageQuery): Promise<IUsageRow[]> {
    return this.inner.usage(query)
  }

  listSessions(options?: { limit?: number; filter?: Record<string, unknown>; owner?: IOwnerFilter | null }): Promise<IConversationSession[]> {
    return this.inner.listSessions(options)
  }

  assignProject(agentIds: readonly string[], projectId: string): Promise<number> {
    return this.inner.assignProject(agentIds, projectId)
  }

  pageSessions(query: IConversationPageQuery): Promise<IConversationPage> {
    return this.inner.pageSessions(query)
  }

  listTurns(sessionId: string): Promise<IConversationTurn[]> {
    return this.inner.listTurns(sessionId)
  }

  findSession(sessionId: string): Promise<IConversationSession | undefined> {
    return this.inner.findSession(sessionId)
  }

  findByShareId(shareId: string): Promise<IConversationSession | undefined> {
    return this.inner.findByShareId(shareId)
  }

  /** Relê do banco e publica: quem escuta recebe o estado gravado, não o que se pretendia gravar. */
  private async announce(sessionId: string): Promise<void> {
    const session = await this.inner.findSession(sessionId)
    if (session) this.events.publish({ type: 'conversation.updated', session })
  }
}
