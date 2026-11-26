import { randomBytes } from 'node:crypto'
import {
  IPersonMessage,
  IPersonMessageFile,
  IPersonThread,
  isRequestKey,
  isRequestLevel,
  messageKeyOf,
  NOTIFY_TOOL,
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
  /** A conversa é de uma DELEGAÇÃO (a de um subagente). */
  delegated?: boolean
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

/** O que o serviço conta a quem acompanha (o `/connect` da origem): a caixa mudou, ou o agente escreveu uma mensagem nova. */
export interface IPersonMessagesWatcher {
  changed?(recipientId: string, conversationId: string): void
  sent?(message: IPersonMessage): void
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

  private readonly watchers = new Set<IPersonMessagesWatcher>()

  /**
   * 🔌 Quem acompanha a caixa de todos (a rota SSE do `/connect`): `changed` a cada `message.created` do barramento e `sent` a
   * cada mensagem NOVA do agente (com o conteúdo). Devolve quem cancela. O barramento só vale depois do `useEvents`.
   */
  watch(watcher: IPersonMessagesWatcher): () => void {
    this.watchers.add(watcher)
    const unsubscribe = watcher.changed
      ? this.deps.events?.subscribe((event) => {
          if (event.type === 'message.created') watcher.changed?.(event.recipientId, event.conversationId)
        })
      : undefined
    return () => {
      this.watchers.delete(watcher)
      unsubscribe?.()
    }
  }

  /** O agente escreve. Devolve os nomes de quem recebeu. */
  async send(input: { sessionId: string; agentId: string; to: string; title?: string; body: string; level?: string; turn?: number; replyTo?: string }): Promise<string[]> {
    const body = input.body?.trim() ?? ''
    if (!body) throw new PersonMessageError('message is required')
    if (body.length > PERSON_MESSAGE_LIMITS.body) throw new PersonMessageError(`message is longer than ${PERSON_MESSAGE_LIMITS.body} characters`)
    const title = input.title?.trim().slice(0, PERSON_MESSAGE_LIMITS.title) || undefined
    const level: TPersonMessageLevel = (PERSON_MESSAGE_LEVELS as readonly string[]).includes(input.level ?? '') ? (input.level as TPersonMessageLevel) : 'info'
    const conversation = await this.deps.conversation(input.sessionId)
    if (!conversation) throw new PersonMessageError('this conversation was not found')
    // ⛔ SÓ A CONVERSA-MÃE FALA COM A PESSOA: o subagente reporta (pedido ou andamento) a quem delegou, na resposta dele.
    // Respondida direto, a pessoa deixaria a mãe sem saber de nada.
    if (conversation.delegated)
      throw new PersonMessageError(
        'you are in a delegated conversation: do not message people from here. Put what you need or what happened in your reply to the agent that delegated to you; it talks to the person.',
      )
    const recipients = this.recipients(input.to, conversation)
    // 🎯 O agente responde a um PEDIDO (o id que veio na resposta da pessoa): a mensagem fica no item dele, em cada cópia.
    const answering = input.replyTo ? this.requestAcross(input.sessionId, input.replyTo) : undefined
    if (answering && isRequestLevel(level)) throw new PersonMessageError('replyTo is for an info answer to a request; a new request (attention or urgent) opens its own item')
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
        ...(answering ? this.copyOf(answering, recipient.id, answering.recipientId, input.sessionId) : {}),
        createdAt: at,
      }
      this.deps.repository.insert(message)
      this.announce(recipient.id, input.sessionId)
      this.pushTo(message)
      this.told(message)
    }
    return recipients.map((recipient) => recipient.name)
  }

  /** ⛔ `replyTo` é um pedido do agente NESTE fio da pessoa (o id de outro fio ou de uma mensagem comum não vale). */
  /** O pedido `id` desta conversa, na cópia de qualquer destinatário (o agente recebe o id da cópia de quem respondeu). */
  private requestAcross(conversationId: string, id: string): IPersonMessage {
    for (const recipient of this.deps.repository.recipientsOf(conversationId)) {
      const found = this.deps.repository.thread(recipient, conversationId).find((message) => message.id === id)
      if (found?.from === 'agent' && found.status) return found
    }
    throw new PersonMessageError(`replyTo ${id} is not a request of this conversation`, 'replyTo')
  }

  private requestOf(mine: IPersonMessage[], replyTo?: string): IPersonMessage | undefined {
    if (!replyTo) return undefined
    const target = mine.find((message) => message.id === replyTo)
    if (!target || target.from !== 'agent' || !target.status) throw new PersonMessageError('replyTo must be a request (attention or urgent message) from this thread', 'replyTo')
    return target
  }

  /**
   * 🔑 O item da pessoa: a conversa dele e, se for de pedido, o pedido. Ausente = a pessoa não tem esse item. O id de
   * conversa vale mesmo sem item de avisos (só pedidos): é a conversa inteira (o app do Mac e a voz leem assim).
   */
  resolve(recipientId: string, key: string): { conversationId: string; requestId?: string } | undefined {
    if (isRequestKey(key)) {
      const conversationId = this.deps.repository.item(recipientId, key)[0]?.conversationId
      return conversationId ? { conversationId, requestId: key } : undefined
    }
    return this.deps.repository.thread(recipientId, key).length ? { conversationId: key } : undefined
  }

  /** Confere o `replyTo` antes de qualquer efeito (a conversa ainda nem foi aberta). */
  checkReplyTo(recipientId: string, key: string, replyTo?: string): void {
    const found = this.resolve(recipientId, key)
    if (found) this.requestOf(this.deps.repository.thread(recipientId, found.conversationId), replyTo ?? found.requestId)
  }

  /**
   * 💬 A PESSOA RESPONDE pela caixa: a resposta vai para o fio de TODOS que receberam aquela conversa (o outro admin vê
   * quem respondeu e o quê) — lida para quem escreveu. Devolve o texto que entra na conversa, com quem respondeu e sobre o
   * quê, para o agente saber de onde veio. ⛔ Só quem tem o fio responde.
   */
  reply(
    recipientId: string,
    key: string,
    text: string,
    authorName: string,
    replyTo?: string,
    files?: IPersonMessageFile[],
  ): { input: string; agentId: string; conversationId: string; requestId?: string } {
    const body = text?.trim() ?? ''
    if (!body && !files?.length) throw new PersonMessageError('message is required')
    if (body.length > PERSON_MESSAGE_LIMITS.body) throw new PersonMessageError(`message is longer than ${PERSON_MESSAGE_LIMITS.body} characters`)
    const found = this.resolve(recipientId, key)
    if (!found) throw new PersonMessageError('no such thread')
    const conversationId = found.conversationId
    const mine = this.deps.repository.thread(recipientId, conversationId)
    // No item de um pedido, a resposta é a ele.
    const target = this.requestOf(mine, replyTo ?? found.requestId)
    // ⚖️ Sem pedido, a resposta é ao que a pessoa VIA: a última do agente NESTE item (o da conversa), nunca a última da
    // conversa inteira — essa podia ser um pedido de outro item, e o agente respondia sobre outro assunto.
    const asked = target ?? [...mine].reverse().find((message) => message.from === 'agent' && messageKeyOf(message) === key)
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
        ...(files?.length ? { files: files.map(({ name, mimeType, size }) => ({ name, mimeType, size })) } : {}),
        createdAt: at,
        ...(recipient === recipientId ? { readAt: at } : {}),
      })
      this.announce(recipient, conversationId)
    }
    if (target) {
      this.deps.repository.setStatus(recipientId, conversationId, target.id, 'answered', at)
      this.announce(recipientId, conversationId)
    }
    const about = (message: IPersonMessage) => (message.title || message.body.replace(/\s+/g, ' ').trim()).slice(0, 60)
    const label = target ? ` a "${about(target)}" (pedido ${target.id})` : asked ? ` à sua mensagem "${about(asked)}" (${asked.id})` : ''
    // 🎯 Cada resposta volta ao SEU pedido: o agente responde a ele com `notify` + `replyTo`; o que ficar sem resposta, o
    // gateway preenche com o texto final do turno (ver `ReplyMirror`).
    const how = target ? `\nResponda a ESTE pedido com ${NOTIFY_TOOL} usando replyTo: "${target.id}".` : ''
    const attached = files?.length ? `\n(anexos: ${files.map((file) => file.name).join(', ')})` : ''
    return {
      input: `[Resposta de ${authorName} pela caixa de Mensagens${label}]${how}${attached}\n\n${body}`.trimEnd(),
      agentId: mine[0].agentId,
      conversationId,
      ...(target ? { requestId: target.id } : {}),
    }
  }

  /**
   * 🎯 O pedido `requestId` já tem resposta do agente DEPOIS da última resposta da pessoa a ele (um `notify` com `replyTo`,
   * ou a cópia do gateway): o fim do turno não o preenche de novo.
   */
  answeredAfterReply(conversationId: string, requestId: string): boolean {
    let request: IPersonMessage
    try {
      request = this.requestAcross(conversationId, requestId)
    } catch {
      return true
    }
    const mine = this.deps.repository.thread(request.recipientId, conversationId)
    let lastReply = -1
    mine.forEach((message, index) => {
      if (message.from === 'person' && message.replyTo === request.id) lastReply = index
    })
    return mine.some((message, index) => index > lastReply && message.from === 'agent' && message.replyTo === request.id)
  }

  /** O `replyTo` na cópia de cada destinatário: cada um tem o seu id do mesmo pedido (mesma hora e mesmo texto). */
  private copyOf(target: IPersonMessage, recipient: string, author: string, conversationId: string): { replyTo?: string } {
    if (recipient === author) return { replyTo: target.id }
    const same = this.deps.repository
      .thread(recipient, conversationId)
      .find((message) => message.from === 'agent' && message.createdAt.getTime() === target.createdAt.getTime() && message.body === target.body && message.level === target.level)
    return same ? { replyTo: same.id } : {}
  }

  /**
   * 💬 A resposta do agente ao que a pessoa mandou pela caixa volta para o fio de todos (não lida). ⛔ Nunca mais "o pedido
   * respondido por último": doze respostas na fila caíam todas no mesmo item. Sem `replyTo`, é o item da conversa.
   */
  mirror(conversationId: string, agentId: string, text: string, level: TPersonMessageLevel = 'info', replyTo?: string): void {
    const body = text.trim().slice(0, PERSON_MESSAGE_LIMITS.body)
    if (!body) return
    const at = this.now()
    // 🎯 Com `replyTo`, o retorno vai PARA DENTRO daquele pedido (a cópia de cada destinatário); sem ele, para o item da conversa.
    let request: IPersonMessage | undefined
    if (replyTo && !isRequestLevel(level)) {
      try {
        request = this.requestAcross(conversationId, replyTo)
      } catch {
        request = undefined
      }
    }
    for (const recipient of this.deps.repository.recipientsOf(conversationId)) {
      const mine = this.deps.repository.thread(recipient, conversationId)
      const projectId = mine[0]?.projectId
      const answered = request ? this.copyOf(request, recipient, request.recipientId, conversationId).replyTo : undefined
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
        ...(answered ? { replyTo: answered } : {}),
        createdAt: at,
      }
      this.deps.repository.insert(message)
      this.announce(recipient, conversationId)
      this.pushTo(message)
      this.told(message)
    }
  }

  /**
   * 🔌 Uma mensagem de um projeto conectado mudou na origem: avisa a caixa DAQUI (o sino e a lista ao vivo), com o total não
   * lido da pessoa (as daqui e as da origem). `conversationId` vazio = só a lista se relê.
   */
  announceRemote(recipientId: string, conversationId: string, remoteUnread: number): void {
    this.deps.events?.publish({ type: 'message.created', recipientId, conversationId, unread: this.deps.repository.unread(recipientId) + remoteUnread })
  }

  threads(recipientId: string, archived = false): IPersonThread[] {
    return this.deps.repository.threads(recipientId, { archived })
  }

  /** As mensagens de um item: o pedido com as respostas; com o id de uma conversa, a conversa inteira. */
  thread(recipientId: string, key: string): IPersonMessage[] {
    return isRequestKey(key) ? this.deps.repository.item(recipientId, key) : this.deps.repository.thread(recipientId, key)
  }

  unread(recipientId: string): number {
    return this.deps.repository.unread(recipientId)
  }

  /** Os pedidos pendentes da pessoa (todos os fios). */
  pending(recipientId: string): number {
    return this.deps.repository.pending(recipientId)
  }

  /** 📌 A pessoa dá o pedido por tratado (`resolved`) ou o reabre (`pending`). Só pedido do fio dela. */
  setStatus(recipientId: string, key: string, messageId: string, status: TPersonMessageStatus): void {
    if (status !== 'resolved' && status !== 'pending') throw new PersonMessageError('status must be resolved or pending', 'status')
    const conversationId = this.resolve(recipientId, key)?.conversationId ?? key
    const message = this.deps.repository.thread(recipientId, conversationId).find((candidate) => candidate.id === messageId)
    if (!message) throw new PersonMessageError('no such message')
    if (message.from !== 'agent' || !message.status) throw new PersonMessageError('only requests (attention or urgent messages) have a status', 'status')
    this.deps.repository.setStatus(recipientId, conversationId, messageId, status, this.now())
    this.announce(recipientId, conversationId)
  }

  /** Lê um item (o id de um pedido ou de uma conversa: aí, os avisos dela). */
  markRead(recipientId: string, key: string): void {
    const conversationId = this.resolve(recipientId, key)?.conversationId ?? key
    if (this.deps.repository.markRead(recipientId, key, this.now())) this.announce(recipientId, conversationId)
  }

  setArchived(recipientId: string, key: string, archived: boolean): void {
    const conversationId = this.resolve(recipientId, key)?.conversationId ?? key
    this.deps.repository.setArchived(recipientId, key, archived, this.now())
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

  private told(message: IPersonMessage): void {
    for (const watcher of this.watchers) {
      try {
        watcher.sent?.(message)
      } catch {
        // Quem acompanha é extra: falhar nele não desfaz a mensagem.
      }
    }
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
