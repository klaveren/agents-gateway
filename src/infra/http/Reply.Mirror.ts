import { IConversationEvents } from '@domain/ports/ConversationEvents.Port'

export interface IReplyMirrorDeps {
  events: IConversationEvents
  /** O último turno gravado da conversa: o índice e o texto, e se o agente já escreveu à pessoa (`notify`). */
  lastTurn: (conversationId: string) => Promise<{ index: number; text: string; notified: boolean } | undefined>
  /** Copia o texto para o fio da pessoa. */
  mirror: (conversationId: string, agentId: string, text: string) => void
  /** O turno é gravado um instante depois do fim. */
  settleMs?: number
  /** O teto da espera: a conversa que nunca para não segura a espera para sempre. */
  waitMs?: number
}

/**
 * 💬 A RESPOSTA PELA CAIXA COM A CONVERSA RODANDO: a resposta entra na fila do turno, e quando a conversa para, o último
 * turno volta para o fio da pessoa.
 *
 * ⛔ UMA ESPERA POR CONVERSA, E O MESMO TURNO NUNCA DUAS VEZES: antes, cada resposta abria a sua espera; doze respostas
 * com a Maya rodando acordaram juntas no fim e copiaram o mesmo turno doze vezes (24/11, 22:36).
 */
export class ReplyMirror {
  private readonly waiting = new Set<string>()
  private readonly mirrored = new Map<string, number>()

  constructor(private readonly deps: IReplyMirrorDeps) {}

  /** O turno `index` já foi copiado (pelo caminho da conversa parada): a espera não o copia de novo. */
  markMirrored(conversationId: string, index: number): void {
    this.mirrored.set(conversationId, index)
  }

  wasMirrored(conversationId: string, index: number): boolean {
    return this.mirrored.get(conversationId) === index
  }

  async whenIdle(conversationId: string, agentId: string): Promise<void> {
    if (this.waiting.has(conversationId)) return
    this.waiting.add(conversationId)
    try {
      await this.idle(conversationId)
      await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs ?? 1500))
      const last = await this.deps.lastTurn(conversationId).catch(() => undefined)
      if (!last || last.notified || this.wasMirrored(conversationId, last.index)) return
      this.markMirrored(conversationId, last.index)
      this.deps.mirror(conversationId, agentId, last.text)
    } finally {
      this.waiting.delete(conversationId)
    }
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
