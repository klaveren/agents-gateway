import { EventEmitter } from 'node:events'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IConversationEvents } from '@domain/ports/ConversationEvents.Port'
import { ILiveTurnSnapshot, ITurnLive, TLiveTurnSignal } from '@domain/ports/TurnLive.Port'

interface IRunning extends ILiveTurnSnapshot {
  ticket: number
  metadata?: Record<string, unknown>
}

/**
 * O turno ao vivo, em memória (um gateway, um barramento).
 *
 * ⚖️ O retrato junta os pedaços de texto e de raciocínio seguidos num evento só: quem chega no meio de um turno longo
 * recebe a resposta inteira, não milhares de pedaços. As ferramentas ficam uma a uma, em ordem.
 *
 * ⚠️ Também avisa a caixa de entrada (`conversation.running` e `conversation.idle`), para a lista mostrar quem está
 * rodando. ⛔ Ouvinte que lança não derruba o turno.
 */
export class TurnLive implements ITurnLive {
  private readonly turns = new Map<string, IRunning>()
  private readonly emitter = new EventEmitter().setMaxListeners(0)
  private tickets = 0

  constructor(private readonly conversations?: IConversationEvents) {}

  start(sessionId: string, request: string, metadata?: Record<string, unknown>): number {
    const ticket = ++this.tickets
    const turn: IRunning = { ticket, request, startedAt: new Date(), events: [], ...(metadata ? { metadata } : {}) }
    this.turns.set(sessionId, turn)
    this.signal(sessionId, { type: 'turn.started', turn: this.view(turn) })
    this.conversations?.publish({ type: 'conversation.running', sessionId, ...(metadata ? { metadata } : {}) })
    return ticket
  }

  push(sessionId: string, event: IAgentEvent): void {
    const turn = this.turns.get(sessionId)
    if (!turn) return
    const last = turn.events[turn.events.length - 1]
    if ((event.type === 'text.delta' || event.type === 'reasoning.delta') && last?.type === event.type) {
      turn.events[turn.events.length - 1] = { ...event, timestamp: last.timestamp, payload: { text: last.payload.text + event.payload.text } }
    } else turn.events.push(event)
    this.signal(sessionId, { type: 'turn.event', event })
  }

  finish(sessionId: string, ticket: number): void {
    const turn = this.turns.get(sessionId)
    if (turn?.ticket !== ticket) return
    this.turns.delete(sessionId)
    this.signal(sessionId, { type: 'turn.finished' })
    this.conversations?.publish({ type: 'conversation.idle', sessionId, ...(turn.metadata ? { metadata: turn.metadata } : {}) })
  }

  snapshot(sessionId: string): ILiveTurnSnapshot | undefined {
    const turn = this.turns.get(sessionId)
    return turn ? this.view(turn) : undefined
  }

  subscribe(sessionId: string, listener: (signal: TLiveTurnSignal) => void): () => void {
    this.emitter.on(sessionId, listener)
    return () => this.emitter.off(sessionId, listener)
  }

  running(): Array<{ sessionId: string; metadata?: Record<string, unknown> }> {
    return [...this.turns].map(([sessionId, turn]) => ({ sessionId, ...(turn.metadata ? { metadata: turn.metadata } : {}) }))
  }

  private view(turn: IRunning): ILiveTurnSnapshot {
    return { request: turn.request, startedAt: turn.startedAt, events: [...turn.events] }
  }

  private signal(sessionId: string, signal: TLiveTurnSignal): void {
    for (const listener of this.emitter.listeners(sessionId) as Array<(signal: TLiveTurnSignal) => void>) {
      try {
        listener(signal)
      } catch (error) {
        console.warn('[live] um ouvinte falhou; os outros seguem.', error)
      }
    }
  }
}
