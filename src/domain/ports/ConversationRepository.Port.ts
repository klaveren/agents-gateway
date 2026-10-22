import { TClassification } from '@domain/models/Classification.Model'
import { IConversationPage, IConversationPageQuery, IConversationSession, IConversationStats, IConversationTurn, IOwnerFilter } from '@domain/models/Conversation.Model'

/**
 * Onde a conversa fica guardada. O domínio não sabe qual é o banco — nem se existe um.
 *
 * ⚠️ NENHUM MÉTODO AQUI PODE DERRUBAR UM TURNO. A implementação registra; se o banco cair, a
 * conversa continua acontecendo — o mesmo princípio que o `McpServerClient` já segue com o MCP fora
 * do ar. Perder o registro de um turno é ruim; perder o turno de quem estava trabalhando é pior, e
 * é o que aconteceria se um `await` de escrita lançasse no meio do stream. A única exceção é `setShared`,
 * que nunca roda dentro de um turno (ver abaixo).
 */
export interface IConversationRepository {
  /** Cria ou atualiza o cabeçalho da conversa. */
  saveSession(session: IConversationSession): Promise<void>

  /** Acrescenta um turno e atualiza os contadores do cabeçalho. */
  appendTurn(turn: IConversationTurn): Promise<void>

  /** O retrato agregado de TODAS as conversas — somado no banco, não sobre a página listada. */
  stats(): Promise<IConversationStats>

  /**
   * Rotula um turno já gravado e recalcula o rótulo da conversa: o PIOR entre os turnos (`worstOf`).
   *
   * ⚖️ Passo separado do `appendTurn` de propósito: classificar custa uma chamada a um modelo, e o
   * turno não pode esperar por ela para ser registrado. Grava-se primeiro o que aconteceu; o rótulo
   * chega depois. Só ARMAZENA — quem classifica é outra peça.
   */
  classifyTurn(sessionId: string, index: number, classification: TClassification): Promise<void>

  /**
   * Conversas mais recentes primeiro. `filter` casa contra `metadata`.
   *
   * `owner` recorta pelo DONO (`metadata.owner`): `{ id, account? }` devolve só as dele, `null` só as
   * SEM dono, ausente não recorta. É o que impede a lista de uma pessoa de ser a de todo mundo.
   */
  listSessions(options?: { limit?: number; filter?: Record<string, unknown>; owner?: IOwnerFilter | null }): Promise<IConversationSession[]>

  /**
   * Uma página de TODAS as conversas, para o monitor: busca, filtro e paginação no banco.
   *
   * ⚖️ Existe ao lado de `listSessions` porque recorta outra coisa: aquele filtra pelo DONO, este
   * atravessa todos e só deve ser chamado por quem administra.
   */
  pageSessions(query: IConversationPageQuery): Promise<IConversationPage>

  /** Os turnos de uma conversa, em ordem. É isto que reabre o histórico. */
  listTurns(sessionId: string): Promise<IConversationTurn[]>

  /**
   * O cabeçalho de UMA conversa. Existe para responder "de quem é isto?" antes de entregar o
   * conteúdo — filtrar a listagem não protege nada se o detalhe abre por id.
   */
  findSession(sessionId: string): Promise<IConversationSession | undefined>

  /**
   * Abre ou fecha a conversa por link. `shareId` só entra quando vem: fechar não o apaga, para
   * reabrir devolver o MESMO link.
   *
   * ⚠️ Fechar precisa REVOGAR de verdade — o link continua na mão de quem o recebeu, e é a leitura
   * por `findByShareId` que decide se ele ainda abre.
   *
   * ⛔ ÚNICA escrita que NÃO engole o erro: aqui a escrita É a ação pedida, e falhar em silêncio
   * diria "descompartilhado" com o link ainda aberto. Não roda dentro de um turno, então lançar não
   * derruba conversa nenhuma.
   */
  setShared(sessionId: string, shared: boolean, shareId?: string): Promise<void>

  /** A conversa cujo LINK público é este `shareId`. Distinta de `findSession`, que casa pelo id da sessão. */
  findByShareId(shareId: string): Promise<IConversationSession | undefined>

  /**
   * Apaga o registro de uma conversa — cabeçalho e turnos.
   *
   * ⚠️ NÃO ENCOSTA NA SESSÃO VIVA. Quem quer parar o que está rodando cancela a sessão; isto aqui
   * só remove o histórico. São coisas distintas, e apagar as duas de uma vez esconderia que a
   * conversa pode continuar viva na memória do provider depois de sumir da lista.
   */
  deleteSession(sessionId: string): Promise<void>
}
