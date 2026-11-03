import { EventEmitter } from 'node:events'
import { ICatalogChanged, ICatalogEvents } from '@domain/ports/CatalogEvents.Port'

const CHANNEL = 'catalog'

/**
 * O barramento em memória do catálogo (o mesmo molde do das conversas). ⛔ Ouvinte que lança não derruba quem
 * publicou: publicar acontece no caminho da escrita, que já aconteceu.
 */
export class InMemoryCatalogEvents implements ICatalogEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  publish(changes: readonly ICatalogChanged[]): void {
    if (!changes.length) return
    for (const listener of this.emitter.listeners(CHANNEL) as Array<(changes: readonly ICatalogChanged[]) => void>) {
      try {
        listener(changes)
      } catch (error) {
        console.warn('[events] um ouvinte do catálogo falhou; os outros seguem.', error)
      }
    }
  }

  subscribe(listener: (changes: readonly ICatalogChanged[]) => void): () => void {
    this.emitter.on(CHANNEL, listener)
    return () => this.emitter.off(CHANNEL, listener)
  }
}
