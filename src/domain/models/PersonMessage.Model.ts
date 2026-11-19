/**
 * 💬 AS MENSAGENS DOS AGENTES PARA AS PESSOAS (a tela Mensagens): o agente escreve com `notify` e a mensagem cai na caixa
 * de quem ele chamou — os admins do projeto, o dono da conversa ou uma pessoa do projeto. A pessoa responde ali mesmo, e a
 * resposta entra na conversa de origem como mensagem dela.
 *
 * ⚖️ UM FIO POR PESSOA E CONVERSA (`conversationId` é o fio): cada destinatário tem a sua cópia (ler e arquivar são dele).
 * `turn` é o turno da conversa em que a mensagem saiu — a tela mostra o contexto até ali e abre a conversa naquele ponto.
 */
export const NOTIFY_TOOL = 'notify'

export const PERSON_MESSAGE_LEVELS = ['info', 'attention', 'urgent'] as const
export type TPersonMessageLevel = (typeof PERSON_MESSAGE_LEVELS)[number]

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
}

/** Um fio na lista: a conversa, a última mensagem e quantas não lidas. */
export interface IPersonThread {
  conversationId: string
  agentId: string
  projectId?: string
  title?: string
  last: IPersonMessage
  unread: number
  archived: boolean
}
