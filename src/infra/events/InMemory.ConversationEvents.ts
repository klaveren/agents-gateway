import { EventEmitter } from 'node:events'
import { IConversationEvents, TConversationEvent } from '@domain/ports/ConversationEvents.Port'

const CHANNEL = 'conversation'

/**
 * O barramento em memória.
 *
 * ⚠️ `setMaxListeners(0)`: cada aba aberta na caixa de entrada é um ouvinte, e o aviso de vazamento
 * do Node dispararia com onze. ⛔ Ouvinte que lança não derruba quem publicou — publicar acontece
 * no caminho do turno, e uma aba com defeito não pode impedir o registro de outro.
 */
export class InMemoryConversationEvents implements IConversationEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  publish(event: TConversationEvent): void {
    for (const listener of this.emitter.listeners(CHANNEL) as Array<(event: TConversationEvent) => void>) {
      try {
        listener(event)
      } catch (error) {
        console.warn('[events] um ouvinte falhou; os outros seguem.', error)
      }
    }
  }

  subscribe(listener: (event: TConversationEvent) => void): () => void {
    this.emitter.on(CHANNEL, listener)

    return () => this.emitter.off(CHANNEL, listener)
  }
}
