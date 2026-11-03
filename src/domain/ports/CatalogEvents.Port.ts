import { TCatalogKind } from '@domain/Catalog.Document'
import { TRevisionOp } from './CatalogHistoryRepository.Port'

/**
 * Um item do catálogo que mudou (a revisão gravada): o tipo, o id (no MCP, a chave), o escopo e a operação.
 * `permission-request`: um pedido de permissão do agente `id` foi feito ou decidido (não é revisão; só admin recebe).
 */
export interface ICatalogChanged {
  kind: TCatalogKind | 'permission-request'
  id: string
  projectId?: string
  op: TRevisionOp
}

/**
 * O AVISO DE QUE O CATÁLOGO MUDOU, para as telas abertas buscarem de novo o que mostram. Sai do histórico: toda escrita
 * do catálogo (tela, API, MCP, agente, import, rollback) passa por ele.
 *
 * ⛔ NÃO FILTRA POR QUEM VÊ: quem repassa para fora (a rota SSE) decide o que cada chamador pode saber.
 */
export interface ICatalogEvents {
  publish(changes: readonly ICatalogChanged[]): void
  /** Devolve quem cancela a assinatura. */
  subscribe(listener: (changes: readonly ICatalogChanged[]) => void): () => void
}
