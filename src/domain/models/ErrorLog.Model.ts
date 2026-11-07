import type { IConversationScope } from './Conversation.Model'

/**
 * ⚖️ O REGISTRO DE ERROS: o que falhou nas conversas — a ferramenta que voltou com erro, o turno que terminou em erro e o
 * que foi interrompido. Não é uma tabela nova: os turnos já guardam tudo (ver `conversation_turns`); isto é a leitura.
 */
export type TErrorKind = 'tool' | 'turn' | 'aborted' | 'refused'
export const ERROR_KINDS: readonly TErrorKind[] = ['tool', 'turn', 'aborted', 'refused']

/** De onde veio o pedido de turno que foi recusado. */
export type TRefusalOrigin = 'ui' | 'api' | 'hook' | 'schedule'
export const REFUSAL_ORIGINS: readonly TRefusalOrigin[] = ['ui', 'api', 'hook', 'schedule']

/** Os status em que o início de um turno é recusado (sessão ocupada, validação/modelo, teto). O 403 `agent_unavailable` também conta. */
export const REFUSAL_STATUSES: readonly number[] = [409, 422, 429]

/**
 * ⚖️ O turno que NEM COMEÇOU: o início foi recusado (409/422/429) em `POST /sessions`, `/messages` ou `/turns` e nenhum
 * turno foi gravado. Tabela própria (`turn_refusals`), com retenção curta; a mensagem é a da resposta, já mascarada.
 */
export interface ITurnRefusal {
  at: Date
  conversationId?: string
  agentId?: string
  /** O projeto do agente/da conversa; ausente = o escopo global. */
  projectId?: string
  ownerId?: string
  ownerEmail?: string
  status: number
  code: string
  message: string
  origin: TRefusalOrigin
}

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
  /** Ausente na recusa sem conversa (`POST /sessions` recusado). */
  conversationId?: string
  /** O turno da conversa (0 em diante). Ausente na recusa. */
  turn?: number
  agentId: string
  title?: string
  tool?: string
  /** A mensagem (já mascarada quando foi gravada). */
  message: string
  /** Só `refused`: o status HTTP, o código e a origem do pedido. */
  status?: number
  code?: string
  origin?: TRefusalOrigin
}

export interface IErrorLog {
  items: IErrorLogItem[]
  /** Quantos de cada tipo, no recorte (sem o `limit`). */
  byKind: Record<TErrorKind, number>
  /** As ferramentas que mais falham, no recorte. */
  byTool: Array<{ tool: string; count: number }>
}
