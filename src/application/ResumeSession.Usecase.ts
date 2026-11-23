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

  /**
   * `asChild`: a conversa de DELEGAÇÃO volta como filha da mãe gravada (as mesmas travas da delegação). Só a resposta da
   * pessoa a uma mensagem do subagente (tela Mensagens) pede isso; a tela da conversa segue sem retomar filha.
   */
  async execute(session: IConversationSession, adminAccess: boolean, options: { asChild?: boolean } = {}): Promise<void> {
    if (!this.agentProvider.resume) return
    const [turns, native] = await Promise.all([this.conversations.listTurns(session.id), this.conversations.findNative?.(session.id)])
    const parent = session.metadata?.delegatedBy
    const delegatedBy = options.asChild && typeof parent === 'string' ? parent : undefined
    await this.agentProvider.resume({ session, turns, adminAccess, ...(delegatedBy ? { delegatedBy } : {}), ...(native ? { native } : {}) })
  }
}
