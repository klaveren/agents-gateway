import { randomBytes } from 'node:crypto'
import { IPersonMessage, IPersonThread, PERSON_MESSAGE_LEVELS, PERSON_MESSAGE_LIMITS, TPersonMessageLevel } from '@domain/models/PersonMessage.Model'
import type { IConversationEvents } from '@domain/ports/ConversationEvents.Port'
import type { IPersonMessageRepository } from '@domain/ports/PersonMessageRepository.Port'

/** O que o serviço precisa saber da conversa de origem. */
export interface IMessageConversation {
  ownerId?: string
  projectId?: string
}

export interface IPersonMessagesDeps {
  repository: IPersonMessageRepository
  events?: IConversationEvents
  conversation(sessionId: string): Promise<IMessageConversation | undefined>
  /** Os membros do projeto, com o papel. */
  members(projectId: string): Array<{ userId: string; role: 'admin' | 'member' }>
  /** As contas (para achar a pessoa pelo nome ou e-mail e os administradores do gateway). */
  accounts(): Array<{ id: string; email: string; name: string; role: string; disabled: boolean }>
  now?: () => Date
}

export class PersonMessageError extends Error {}

/**
 * 💬 AS MENSAGENS DOS AGENTES PARA AS PESSOAS (ver `PersonMessage.Model`). Quem recebe sai da CONVERSA, nunca do agente:
 * `admins` são os do projeto dela (sem projeto, os do gateway); `owner` é a dona dela; uma pessoa só se for do projeto.
 * ⛔ O remetente é sempre o agente da conversa (a tela mostra), então ninguém se passa pelo sistema nem por outra pessoa.
 */
export class PersonMessagesService {
  constructor(private readonly deps: IPersonMessagesDeps) {}

  /** O barramento da caixa de entrada (nasce depois, com os casos de uso): o sino e a lista acompanham ao vivo. */
  useEvents(events: IConversationEvents): void {
    this.deps.events = events
  }

  /** A conversa de origem pelo MESMO repositório do app (o que os casos de uso gravam). */
  useConversations(conversation: IPersonMessagesDeps['conversation']): void {
    this.deps.conversation = conversation
  }

  /** O agente escreve. Devolve os nomes de quem recebeu. */
  async send(input: { sessionId: string; agentId: string; to: string; title?: string; body: string; level?: string; turn?: number }): Promise<string[]> {
    const body = input.body?.trim() ?? ''
    if (!body) throw new PersonMessageError('message is required')
    if (body.length > PERSON_MESSAGE_LIMITS.body) throw new PersonMessageError(`message is longer than ${PERSON_MESSAGE_LIMITS.body} characters`)
    const title = input.title?.trim().slice(0, PERSON_MESSAGE_LIMITS.title) || undefined
    const level: TPersonMessageLevel = (PERSON_MESSAGE_LEVELS as readonly string[]).includes(input.level ?? '') ? (input.level as TPersonMessageLevel) : 'info'
    const conversation = await this.deps.conversation(input.sessionId)
    if (!conversation) throw new PersonMessageError('this conversation was not found')
    const recipients = this.recipients(input.to, conversation)
    const at = this.now()
    for (const recipient of recipients) {
      this.deps.repository.insert({
        id: `m_${randomBytes(9).toString('hex')}`,
        recipientId: recipient.id,
        conversationId: input.sessionId,
        ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
        agentId: input.agentId,
        from: 'agent',
        ...(title ? { title } : {}),
        body,
        level,
        ...(input.turn !== undefined ? { turn: input.turn } : {}),
        createdAt: at,
      })
      this.announce(recipient.id, input.sessionId)
    }
    return recipients.map((recipient) => recipient.name)
  }

  threads(recipientId: string, archived = false): IPersonThread[] {
    return this.deps.repository.threads(recipientId, { archived })
  }

  thread(recipientId: string, conversationId: string): IPersonMessage[] {
    return this.deps.repository.thread(recipientId, conversationId)
  }

  unread(recipientId: string): number {
    return this.deps.repository.unread(recipientId)
  }

  markRead(recipientId: string, conversationId: string): void {
    if (this.deps.repository.markRead(recipientId, conversationId, this.now())) this.announce(recipientId, conversationId)
  }

  setArchived(recipientId: string, conversationId: string, archived: boolean): void {
    this.deps.repository.setArchived(recipientId, conversationId, archived, this.now())
    this.announce(recipientId, conversationId)
  }

  /** Quem recebe: `admins`, `owner` ou uma pessoa do projeto (pelo e-mail ou pelo nome). */
  private recipients(to: string, conversation: IMessageConversation): Array<{ id: string; name: string }> {
    const accounts = this.deps.accounts().filter((account) => !account.disabled)
    const named = (ids: readonly string[]) => ids.flatMap((id) => accounts.filter((account) => account.id === id).map((account) => ({ id, name: account.name || account.email })))
    const target = (to ?? '').trim()
    if (target === 'admins') {
      const ids = conversation.projectId
        ? this.deps
            .members(conversation.projectId)
            .filter((member) => member.role === 'admin')
            .map((member) => member.userId)
        : accounts.filter((account) => account.role === 'admin').map((account) => account.id)
      const found = named(ids)
      if (!found.length) throw new PersonMessageError('this project has no administrator to receive it')
      return found
    }
    if (target === 'owner') {
      const found = conversation.ownerId ? named([conversation.ownerId]) : []
      if (!found.length) throw new PersonMessageError('this conversation has no owner (it was opened by an integration): use admins')
      return found
    }
    // ⛔ Uma pessoa: só quem é do projeto da conversa (sem projeto, só a dona dela e os administradores do gateway).
    const allowed = conversation.projectId
      ? this.deps.members(conversation.projectId).map((member) => member.userId)
      : [...(conversation.ownerId ? [conversation.ownerId] : []), ...accounts.filter((account) => account.role === 'admin').map((account) => account.id)]
    const pool = accounts.filter((account) => allowed.includes(account.id))
    const wanted = target.toLowerCase()
    const byEmail = pool.filter((account) => account.email.toLowerCase() === wanted)
    const byName = pool.filter((account) => account.name.trim().toLowerCase() === wanted)
    const match = byEmail.length ? byEmail : byName
    if (match.length === 1) return [{ id: match[0].id, name: match[0].name || match[0].email }]
    const names = pool.map((account) => account.name || account.email).join(', ')
    if (match.length > 1) throw new PersonMessageError(`more than one person is called "${target}": use the e-mail (${names})`)
    throw new PersonMessageError(`"${target}" is not in this project. Use admins, owner or one of: ${names || 'nobody'}`)
  }

  private announce(recipientId: string, conversationId: string): void {
    this.deps.events?.publish({ type: 'message.created', recipientId, conversationId, unread: this.deps.repository.unread(recipientId) })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
}
