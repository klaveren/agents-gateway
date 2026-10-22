import { IOwnerFilter, IStoredUsage } from './Conversation.Model'

/**
 * O recorte de uso: desde quando, em que fuso, e de quem.
 *
 * ⚖️ O FUSO É DE QUEM PERGUNTA (`tzOffsetMinutes`, como o navegador informa): o "hoje" da tela é o hoje
 * da pessoa. Em UTC, um turno das 22h de São Paulo cairia no dia seguinte.
 */
export interface IUsageQuery {
  since: Date
  /** Minutos a SOMAR ao UTC para chegar ao horário local (São Paulo: -180). */
  tzOffsetMinutes: number
  /**
   * `{ id, account }` = só as conversas desse dono (o mesmo recorte da listagem); `null` = só as SEM dono;
   * ausente = todas (o admin).
   */
  owner?: IOwnerFilter | null
}

/**
 * Uma linha do uso: um dia de uma conversa. É o grão de onde sai todo o resto (dia, agente, modelo,
 * usuário, conversa) — a conta de "quantas conversas" pede o id da conversa, e ele está aqui.
 */
export interface IUsageRow {
  day: string
  conversationId: string
  title?: string
  ownerId?: string
  ownerEmail?: string
  agentId: string
  provider: string
  model: string
  turns: number
  usage: IStoredUsage
}
