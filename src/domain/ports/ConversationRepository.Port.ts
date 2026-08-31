import { IConversationSession, IConversationStats, IConversationTurn } from '@domain/models/Conversation.Model'

/**
 * Onde a conversa fica guardada. O domínio não sabe qual é o banco — nem se existe um.
 *
 * ⚠️ NENHUM MÉTODO AQUI PODE DERRUBAR UM TURNO. A implementação registra; se o banco cair, a
 * conversa continua acontecendo — o mesmo princípio que o `McpServerClient` já segue com o MCP fora
 * do ar. Perder o registro de um turno é ruim; perder o turno de quem estava trabalhando é pior, e
 * é o que aconteceria se um `await` de escrita lançasse no meio do stream.
 */
export interface IConversationRepository {
  /** Cria ou atualiza o cabeçalho da conversa. */
  saveSession(session: IConversationSession): Promise<void>

  /** Acrescenta um turno e atualiza os contadores do cabeçalho. */
  appendTurn(turn: IConversationTurn): Promise<void>

  /** O retrato agregado de TODAS as conversas — somado no banco, não sobre a página listada. */
  stats(): Promise<IConversationStats>

  /** Conversas mais recentes primeiro. `filter` casa contra `metadata`. */
  listSessions(options?: { limit?: number; filter?: Record<string, unknown> }): Promise<IConversationSession[]>

  /** Os turnos de uma conversa, em ordem. É isto que reabre o histórico. */
  listTurns(sessionId: string): Promise<IConversationTurn[]>

  /**
   * O cabeçalho de UMA conversa. Existe para responder "de quem é isto?" antes de entregar o
   * conteúdo — filtrar a listagem não protege nada se o detalhe abre por id.
   */
  findSession(sessionId: string): Promise<IConversationSession | undefined>

  /**
   * Apaga o registro de uma conversa — cabeçalho e turnos.
   *
   * ⚠️ NÃO ENCOSTA NA SESSÃO VIVA. Quem quer parar o que está rodando cancela a sessão; isto aqui
   * só remove o histórico. São coisas distintas, e apagar as duas de uma vez esconderia que a
   * conversa pode continuar viva na memória do provider depois de sumir da lista.
   */
  deleteSession(sessionId: string): Promise<void>
}
