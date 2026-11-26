import { IConversationEvents } from '@domain/ports/ConversationEvents.Port'

/** O turno que terminou: o índice, o texto final, se o agente escreveu à pessoa (`notify`) e o erro, se falhou. */
export interface IReplyTurn {
  index: number
  text: string
  notified: boolean
  error?: string
}

export interface IReplyMirrorDeps {
  events: IConversationEvents
  /** O último turno gravado da conversa. */
  lastTurn: (conversationId: string) => Promise<IReplyTurn | undefined>
  /** Copia o texto para o fio da pessoa: com `replyTo`, para dentro daquele pedido; com `attention`, como pedido novo. */
  mirror: (conversationId: string, agentId: string, text: string, options?: { replyTo?: string; level?: 'attention' }) => void
  /** O pedido já tem resposta do agente depois da última resposta da pessoa a ele (`notify` + `replyTo`). */
  answered: (conversationId: string, requestId: string) => boolean
  /** O turno é gravado um instante depois do fim. */
  settleMs?: number
  /** O teto da espera: a conversa que nunca para não segura a espera para sempre. */
  waitMs?: number
}

/** O que espera o fim do turno numa conversa: os pedidos respondidos pela pessoa e se ela respondeu à conversa (sem pedido). */
interface IAwaiting {
  requests: Set<string>
  conversation: boolean
}

/**
 * 💬 A RESPOSTA PELA CAIXA VOLTA AO PEDIDO CERTO. A pessoa responde a um pedido; a resposta entra no turno (na fila, com a
 * conversa rodando) e o gateway ANOTA o pedido. No fim do turno: o pedido que o agente respondeu com `notify` + `replyTo`
 * está pronto; o que ficou sem resposta recebe o texto final do turno, uma vez. A resposta à conversa (sem pedido) recebe
 * o texto final se o agente não escreveu com `notify`.
 *
 * ⛔ UMA ESPERA POR CONVERSA, E O MESMO TURNO NUNCA DUAS VEZES: doze respostas com a Maya rodando acordaram juntas e
 * copiaram o mesmo turno doze vezes (24/11, 22:36); depois, voltaram uma vez, mas todas no pedido respondido por último.
 */
export class ReplyMirror {
  private readonly waiting = new Set<string>()
  private readonly mirrored = new Map<string, number>()
  private readonly awaiting = new Map<string, IAwaiting>()

  constructor(private readonly deps: IReplyMirrorDeps) {}

  /** A pessoa respondeu: `requestId` é o pedido (sem ele, a resposta é à conversa). */
  expect(conversationId: string, requestId?: string): void {
    const awaiting = this.awaiting.get(conversationId) ?? { requests: new Set<string>(), conversation: false }
    if (requestId) awaiting.requests.add(requestId)
    else awaiting.conversation = true
    this.awaiting.set(conversationId, awaiting)
  }

  /** O turno `index` já foi copiado: a resposta à conversa não o copia de novo. */
  markMirrored(conversationId: string, index: number): void {
    this.mirrored.set(conversationId, index)
  }

  wasMirrored(conversationId: string, index: number): boolean {
    return this.mirrored.get(conversationId) === index
  }

  /** A conversa rodando: espera ela parar e fecha o que estava anotado até ali. */
  async whenIdle(conversationId: string, agentId: string): Promise<void> {
    if (this.waiting.has(conversationId)) return
    this.waiting.add(conversationId)
    try {
      await this.idle(conversationId)
      // ⚖️ O que chegou DEPOIS do fim é de outro turno (o que ele abriu fecha o seu): só o anotado até aqui.
      const awaiting = this.take(conversationId)
      await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs ?? 1500))
      const last = await this.deps.lastTurn(conversationId).catch(() => undefined)
      if (last && awaiting) this.close(conversationId, agentId, last, awaiting)
    } finally {
      this.waiting.delete(conversationId)
    }
  }

  /** O turno que a resposta abriu terminou: fecha o que estava anotado. */
  settle(conversationId: string, agentId: string, turn: IReplyTurn): void {
    const awaiting = this.take(conversationId)
    if (awaiting) this.close(conversationId, agentId, turn, awaiting)
  }

  private take(conversationId: string): IAwaiting | undefined {
    const awaiting = this.awaiting.get(conversationId)
    this.awaiting.delete(conversationId)
    return awaiting
  }

  private close(conversationId: string, agentId: string, turn: IReplyTurn, awaiting: IAwaiting): void {
    // O turno já copiado não volta à conversa (nem o aviso de falha); os pedidos se guardam pelo `answered`.
    const already = this.wasMirrored(conversationId, turn.index)
    this.markMirrored(conversationId, turn.index)
    if (turn.error !== undefined) {
      if (!already) this.deps.mirror(conversationId, agentId, `Não consegui responder: ${turn.error || 'o turno falhou'}`, { level: 'attention' })
      return
    }
    // 🎯 Cada pedido sem resposta do agente recebe o texto final, uma vez (o `answered` vê também a cópia já feita).
    for (const requestId of awaiting.requests) {
      if (!this.deps.answered(conversationId, requestId)) this.deps.mirror(conversationId, agentId, turn.text, { replyTo: requestId })
    }
    if (awaiting.conversation && !turn.notified && !already) this.deps.mirror(conversationId, agentId, turn.text)
  }

  private idle(conversationId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => (unsubscribe(), resolve()), this.deps.waitMs ?? 60 * 60_000)
      timer.unref?.()
      const unsubscribe = this.deps.events.subscribe((event) => {
        if (event.type === 'conversation.idle' && event.sessionId === conversationId) {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  }
}
