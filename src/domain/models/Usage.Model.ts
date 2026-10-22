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
  /** Chave do `metadata` da conversa cujo valor vai em cada linha (`IUsageRow.group`) — o agrupamento de cobrança. */
  groupBy?: string
  /** Só as conversas cujo `metadata[chave]` é igual ao valor (comparado como texto). */
  metadata?: Record<string, string>
}

/** Chave de `metadata` que pode virar caminho JSON no SQL: identificador simples, e nunca `owner` (o dono tem rotas próprias). */
export const METADATA_KEY = /^[A-Za-z0-9_]{1,64}$/

export function metadataKeyIssue(key: string): string | undefined {
  if (!METADATA_KEY.test(key)) return `use 1–64 letters, digits or _: ${key}`
  if (key.toLowerCase().startsWith('owner')) return 'owner is the signed-in identity; use /usage/users'
  return undefined
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
  /** O valor de `metadata[groupBy]` da conversa, como texto. Ausente = a conversa não tem a chave. */
  group?: string
  turns: number
  usage: IStoredUsage
}
