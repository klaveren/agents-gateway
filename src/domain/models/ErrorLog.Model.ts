import type { IConversationScope } from './Conversation.Model'

/**
 * ⚖️ O REGISTRO DE ERROS: o que falhou nas conversas — a ferramenta que voltou com erro, o turno que terminou em erro e o
 * que foi interrompido. Não é uma tabela nova: os turnos já guardam tudo (ver `conversation_turns`); isto é a leitura.
 */
export type TErrorKind = 'tool' | 'turn' | 'aborted'
export const ERROR_KINDS: readonly TErrorKind[] = ['tool', 'turn', 'aborted']

export interface IErrorLogQuery {
  since: Date
  /** Só os erros das conversas deste recorte (ver `IConversationScope`). */
  scope?: IConversationScope
  agentId?: string
  tool?: string
  kind?: TErrorKind
  limit?: number
}

export interface IErrorLogItem {
  at: Date
  kind: TErrorKind
  conversationId: string
  /** O turno da conversa (0 em diante). */
  turn: number
  agentId: string
  title?: string
  tool?: string
  /** A mensagem (já mascarada quando foi gravada). */
  message: string
}

export interface IErrorLog {
  items: IErrorLogItem[]
  /** Quantos de cada tipo, no recorte (sem o `limit`). */
  byKind: Record<TErrorKind, number>
  /** As ferramentas que mais falham, no recorte. */
  byTool: Array<{ tool: string; count: number }>
}
