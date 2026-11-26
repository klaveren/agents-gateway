/**
 * 💬 AS MENSAGENS DOS AGENTES PARA AS PESSOAS (a tela Mensagens): o agente escreve com `notify` e a mensagem cai na caixa
 * de quem ele chamou — os admins do projeto, o dono da conversa ou uma pessoa do projeto. A pessoa responde ali mesmo, e a
 * resposta entra na conversa de origem como mensagem dela.
 *
 * ⚖️ UM ITEM POR PEDIDO: cada pedido do agente (`attention`/`urgent`) é um item da caixa, com as respostas a ele; os avisos
 * comuns (`info`) da mesma conversa ficam juntos num item da conversa. A conversa é o contexto, não a chave (ver
 * `messageKeyOf`). Cada destinatário tem a sua cópia (ler e arquivar são dele).
 * `turn` é o turno da conversa em que a mensagem saiu — a tela mostra o contexto até ali e abre a conversa naquele ponto.
 */
export const NOTIFY_TOOL = 'notify'

export const PERSON_MESSAGE_LEVELS = ['info', 'attention', 'urgent'] as const
export type TPersonMessageLevel = (typeof PERSON_MESSAGE_LEVELS)[number]

/**
 * 📌 PEDIDO: a mensagem do agente com nível `attention` ou `urgent`. Cada pedido tem o seu estado, para a pessoa responder
 * e acompanhar um por um: `pending` (esperando), `answered` (ela respondeu a ele) e `resolved` (ela deu por tratado, fora
 * da caixa). Mensagem `info` não tem estado.
 */
export const PERSON_MESSAGE_STATUSES = ['pending', 'answered', 'resolved'] as const
export type TPersonMessageStatus = (typeof PERSON_MESSAGE_STATUSES)[number]

export const isRequestLevel = (level: TPersonMessageLevel): boolean => level === 'attention' || level === 'urgent'

export const PERSON_MESSAGE_LIMITS = { title: 120, body: 8000 } as const

export interface IPersonMessage {
  id: string
  /** Quem recebe (a conta). */
  recipientId: string
  /** A conversa de origem: é o fio. */
  conversationId: string
  projectId?: string
  /** O agente da conversa. */
  agentId: string
  /** `agent` = o agente escreveu; `person` = a resposta de quem recebeu (vai para a conversa). */
  from: 'agent' | 'person'
  /** Na resposta da pessoa: quem respondeu (a conta). */
  authorId?: string
  title?: string
  body: string
  level: TPersonMessageLevel
  /** O turno da conversa em que a mensagem saiu (o contexto e o link). */
  turn?: number
  createdAt: Date
  readAt?: Date
  archivedAt?: Date
  /** Só no pedido (agente, `attention`/`urgent`): o estado dele para quem recebeu. */
  status?: TPersonMessageStatus
  /** Quando o pedido foi respondido. */
  answeredAt?: Date
  /** Na resposta da pessoa: o id do pedido a que ela responde. */
  replyTo?: string
  /** 📎 Na resposta da pessoa: os anexos que foram com ela para a conversa (só o nome, o tipo e o tamanho; o conteúdo vai ao turno). */
  files?: IPersonMessageFile[]
}

export interface IPersonMessageFile {
  name: string
  mimeType: string
  size: number
}

/**
 * 🔑 O ITEM a que a mensagem pertence: o pedido é o próprio item (o id dele); a resposta a um pedido (da pessoa ou o
 * retorno do agente a ela) vai para o item do pedido; o resto, para o item da conversa (o id dela).
 */
export function messageKeyOf(message: Pick<IPersonMessage, 'id' | 'from' | 'status' | 'replyTo' | 'conversationId'>): string {
  if (message.from === 'agent' && message.status) return message.id
  return message.replyTo ?? message.conversationId
}

/** O id de item que é de um pedido (os ids de mensagem começam com `m_`; os de conversa, não). */
export const isRequestKey = (key: string): boolean => key.startsWith('m_')

/** Um item na lista: um pedido (com as respostas) ou os avisos de uma conversa; a última mensagem e quantas não lidas. */
export interface IPersonThread {
  /** O id do item (ver `messageKeyOf`): o do pedido ou o da conversa. */
  id: string
  /** No item de pedido: o id do pedido. */
  requestId?: string
  conversationId: string
  agentId: string
  projectId?: string
  title?: string
  last: IPersonMessage
  unread: number
  /** Quantos pedidos do item ainda estão pendentes (0 ou 1 no item de pedido). */
  pending: number
  /**
   * Quantos pedidos do item ainda estão em aberto: `pending` ou `answered` (respondido, mas não dado por resolvido).
   * Pedido com 0 aqui está resolvido. Opcional: o item de uma origem antiga (projeto conectado) vem sem.
   */
  open?: number
  archived: boolean
  /** 🔌 Só na lista local: o item é de um projeto conectado e mora na origem (`stale`: a origem não respondeu, é a última lista). */
  origin?: { projectId: string; url: string; stale?: boolean }
}
