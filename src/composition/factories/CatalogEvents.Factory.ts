import { InMemoryCatalogEvents } from '@infra/events/InMemory.CatalogEvents'

let instance: InMemoryCatalogEvents | undefined

/** O barramento do catálogo: UM só — o histórico publica, a rota SSE assina. */
export function makeCatalogEvents(): InMemoryCatalogEvents {
  instance ??= new InMemoryCatalogEvents()
  return instance
}
