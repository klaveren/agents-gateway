import { IConversationSession } from '@domain/models/Conversation.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'

/**
 * Retoma uma conversa gravada cuja sessão já não está na memória (ver `AgentProvider.resume`).
 * ⛔ Quem chama confere o DONO antes, com a metadata gravada: este use case não decide acesso.
 */
export class ResumeSessionUseCase {
  constructor(
    private readonly agentProvider: IAgentProvider,
    private readonly conversations: Pick<IConversationRepository, 'listTurns' | 'findNative'>,
  ) {}

  async execute(session: IConversationSession, adminAccess: boolean): Promise<void> {
    if (!this.agentProvider.resume) return
    const [turns, native] = await Promise.all([this.conversations.listTurns(session.id), this.conversations.findNative?.(session.id)])
    await this.agentProvider.resume({ session, turns, adminAccess, ...(native ? { native } : {}) })
  }
}
