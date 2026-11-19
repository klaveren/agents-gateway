import { IPersonMessage, IPersonThread } from '@domain/models/PersonMessage.Model'

/** Onde as mensagens das pessoas ficam (ver `PersonMessage.Model`). */
export interface IPersonMessageRepository {
  insert(message: IPersonMessage): void
  /** Os fios da pessoa, o mais recente primeiro. */
  threads(recipientId: string, options?: { archived?: boolean }): IPersonThread[]
  /** As mensagens de um fio da pessoa, em ordem. */
  thread(recipientId: string, conversationId: string): IPersonMessage[]
  markRead(recipientId: string, conversationId: string, at: Date): number
  setArchived(recipientId: string, conversationId: string, archived: boolean, at: Date): number
  /** Quantas não lidas a pessoa tem (o sino). */
  unread(recipientId: string): number
  /** Os destinatários de um fio (a resposta de um vai para a conversa; os outros veem no fio deles). */
  recipientsOf(conversationId: string): string[]
}
