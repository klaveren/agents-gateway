import type { ICatalogDocument } from './Catalog.Document'
import { wideningsOf } from './Catalog.Widening'

/**
 * DE ONDE VEM O QUE O PEDIDO ABRE (incidente de 26/11: ~170 restaurações misturadas com ampliações que ninguém pediu):
 * - `restoration`: o alvo já teve CADA ampliação do pedido numa revisão anterior do catálogo (o pedido devolve o que havia);
 * - `new`: alguma ampliação o alvo nunca teve. ⛔ A tela não aprova `new` em lote: só item a item, ou numa lista explícita.
 *
 * ⚖️ O MESMO DETECTOR DO CATÁLOGO: a revisão `R` já tinha a ampliação `k` se `wideningsOf(R, alvo pedido)` não traz `k`.
 * Sem histórico, sem alvo ou com ampliação que nenhuma revisão cobre: `new` (na dúvida, trava).
 */
export type TPermissionRequestOrigin = 'restoration' | 'new'

export interface IPermissionRequestOrigin {
  origin: TPermissionRequestOrigin
  /** `restoration`: a revisão mais nova do alvo que já tinha tudo o que o pedido abre (ou, espalhado, a mais velha das que cobrem cada item). */
  restoredRevision?: number
}

/** Uma revisão passada do alvo, já como documento. */
export interface IPastDocument {
  revision: number
  document: ICatalogDocument
}

export function requestOrigin(keys: readonly string[], target: ICatalogDocument | undefined, past: readonly IPastDocument[]): IPermissionRequestOrigin {
  // Nada a abrir: a aprovação não amplia nada (o alvo já tem tudo).
  if (!keys.length) return { origin: 'restoration' }
  if (!target || !past.length) return { origin: 'new' }
  const newestFirst = [...past].sort((a, b) => b.revision - a.revision)
  const latest = new Map<string, number>()
  for (const { revision, document } of newestFirst) {
    let opened: Set<string>
    try {
      opened = new Set(wideningsOf(document, target).map((item) => item.key))
    } catch {
      continue
    }
    const covered = keys.filter((key) => !opened.has(key))
    if (covered.length === keys.length) return { origin: 'restoration', restoredRevision: revision }
    for (const key of covered) if (!latest.has(key)) latest.set(key, revision)
  }
  if (keys.every((key) => latest.has(key))) return { origin: 'restoration', restoredRevision: Math.min(...keys.map((key) => latest.get(key)!)) }
  return { origin: 'new' }
}
