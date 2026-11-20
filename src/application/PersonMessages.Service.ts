import { randomBytes } from 'node:crypto'
import {
  IPersonMessage,
  IPersonThread,
  isRequestLevel,
  PERSON_MESSAGE_LEVELS,
  PERSON_MESSAGE_LIMITS,
  TPersonMessageLevel,
  TPersonMessageStatus,
} from '@domain/models/PersonMessage.Model'
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
  /** 📱 O aviso no aparelho (Web Push) de cada mensagem do agente; quem não ligou não recebe nada. */
  push?: (recipientId: string, message: IPersonMessage) => void
  now?: () => Date
}

export class PersonMessageError extends Error {
  constructor(
    message: string,
    /** O campo da requisição que causou o erro (vira o `field` do 422). */
    readonly field?: string,
  ) {
    super(message)
  }
}

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

  /** 📱 O envio para o aparelho (nasce depois, com o Web Push). */
  usePush(push: IPersonMessagesDeps['push']): void {
    this.deps.push = push
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
      const message: IPersonMessage = {
        id: `m_${randomBytes(9).toString('hex')}`,
        recipientId: recipient.id,
        conversationId: input.sessionId,
        ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
        agentId: input.agentId,
        from: 'agent',
        ...(title ? { title } : {}),
        body,
        level,
        ...(isRequestLevel(level) ? { status: 'pending' as const } : {}),
        ...(input.turn !== undefined ? { turn: input.turn } : {}),
        createdAt: at,
      }
      this.deps.repository.insert(message)
      this.announce(recipient.id, input.sessionId)
      this.pushTo(message)
    }
    return recipients.map((recipient) => recipient.name)
  }

  /** ⛔ `replyTo` é um pedido do agente NESTE fio da pessoa (o id de outro fio ou de uma mensagem comum não vale). */
  private requestOf(mine: IPersonMessage[], replyTo?: string): IPersonMessage | undefined {
    if (!replyTo) return undefined
    const target = mine.find((message) => message.id === replyTo)
    if (!target || target.from !== 'agent' || !target.status) throw new PersonMessageError('replyTo must be a request (attention or urgent message) from this thread', 'replyTo')
    return target
  }

  /** Confere o `replyTo` antes de qualquer efeito (a conversa ainda nem foi aberta). */
  checkReplyTo(recipientId: string, conversationId: string, replyTo?: string): void {
    this.requestOf(this.deps.repository.thread(recipientId, conversationId), replyTo)
  }

  /**
   * 💬 A PESSOA RESPONDE pela caixa: a resposta vai para o fio de TODOS que receberam aquela conversa (o outro admin vê
   * quem respondeu e o quê) — lida para quem escreveu. Devolve o texto que entra na conversa, com quem respondeu e sobre o
   * quê, para o agente saber de onde veio. ⛔ Só quem tem o fio responde.
   */
  reply(recipientId: string, conversationId: string, text: string, authorName: string, replyTo?: string): { input: string; agentId: string } {
    const body = text?.trim() ?? ''
    if (!body) throw new PersonMessageError('message is required')
    if (body.length > PERSON_MESSAGE_LIMITS.body) throw new PersonMessageError(`message is longer than ${PERSON_MESSAGE_LIMITS.body} characters`)
    const mine = this.deps.repository.thread(recipientId, conversationId)
    if (!mine.length) throw new PersonMessageError('no such thread')
    const target = this.requestOf(mine, replyTo)
    const asked = target ?? [...mine].reverse().find((message) => message.from === 'agent')
    const at = this.now()
    for (const recipient of this.deps.repository.recipientsOf(conversationId)) {
      this.deps.repository.insert({
        id: `m_${randomBytes(9).toString('hex')}`,
        recipientId: recipient,
        conversationId,
        ...(mine[0].projectId ? { projectId: mine[0].projectId } : {}),
        agentId: mine[0].agentId,
        from: 'person',
        authorId: recipientId,
        body,
        level: 'info',
        ...(target ? this.copyOf(target, recipient, recipientId, conversationId) : {}),
        createdAt: at,
        ...(recipient === recipientId ? { readAt: at } : {}),
      })
      this.announce(recipient, conversationId)
    }
    if (target) {
      this.deps.repository.setStatus(recipientId, conversationId, target.id, 'answered', at)
      this.announce(recipientId, conversationId)
    }
    const label = target ? ` a "${(target.title || target.body.replace(/\s+/g, ' ').trim()).slice(0, 60)}" (pedido ${target.id})` : asked?.title ? ` (sobre "${asked.title}")` : ''
    return { input: `[Resposta de ${authorName} pela caixa de Mensagens${label}]\n\n${body}`, agentId: mine[0].agentId }
  }

  /** O `replyTo` na cópia de cada destinatário: cada um tem o seu id do mesmo pedido (mesma hora e mesmo texto). */
  private copyOf(target: IPersonMessage, recipient: string, author: string, conversationId: string): { replyTo?: string } {
    if (recipient === author) return { replyTo: target.id }
    const same = this.deps.repository
      .thread(recipient, conversationId)
      .find((message) => message.from === 'agent' && message.createdAt.getTime() === target.createdAt.getTime() && message.body === target.body && message.level === target.level)
    return same ? { replyTo: same.id } : {}
  }

  /** 💬 A resposta do agente ao que a pessoa mandou pela caixa volta para o fio de todos (não lida). */
  mirror(conversationId: string, agentId: string, text: string, level: TPersonMessageLevel = 'info'): void {
    const body = text.trim().slice(0, PERSON_MESSAGE_LIMITS.body)
    if (!body) return
    const at = this.now()
    for (const recipient of this.deps.repository.recipientsOf(conversationId)) {
      const projectId = this.deps.repository.thread(recipient, conversationId)[0]?.projectId
      const message: IPersonMessage = {
        id: `m_${randomBytes(9).toString('hex')}`,
        recipientId: recipient,
        conversationId,
        ...(projectId ? { projectId } : {}),
        agentId,
        from: 'agent',
        body,
        level,
        ...(isRequestLevel(level) ? { status: 'pending' as const } : {}),
        createdAt: at,
      }
      this.deps.repository.insert(message)
      this.announce(recipient, conversationId)
      this.pushTo(message)
    }
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

  /** Os pedidos pendentes da pessoa (todos os fios). */
  pending(recipientId: string): number {
    return this.deps.repository.pending(recipientId)
  }

  /** 📌 A pessoa dá o pedido por tratado (`resolved`) ou o reabre (`pending`). Só pedido do fio dela. */
  setStatus(recipientId: string, conversationId: string, messageId: string, status: TPersonMessageStatus): void {
    if (status !== 'resolved' && status !== 'pending') throw new PersonMessageError('status must be resolved or pending', 'status')
    const message = this.deps.repository.thread(recipientId, conversationId).find((candidate) => candidate.id === messageId)
    if (!message) throw new PersonMessageError('no such message')
    if (message.from !== 'agent' || !message.status) throw new PersonMessageError('only requests (attention or urgent messages) have a status', 'status')
    this.deps.repository.setStatus(recipientId, conversationId, messageId, status, this.now())
    this.announce(recipientId, conversationId)
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

  private pushTo(message: IPersonMessage): void {
    try {
      this.deps.push?.(message.recipientId, message)
    } catch {
      // O aviso no aparelho é extra: falhar nele não desfaz a mensagem.
    }
  }

  private announce(recipientId: string, conversationId: string): void {
    this.deps.events?.publish({ type: 'message.created', recipientId, conversationId, unread: this.deps.repository.unread(recipientId) })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }
}
