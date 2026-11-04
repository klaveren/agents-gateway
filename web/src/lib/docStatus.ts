import type { TDocStatus } from '@/lib/types'

/**
 * O STATUS de um documento (spec, ADR, estudo): proposta, aceita, substituída ou arquivada. Ausente = aceita.
 * Substituída e arquivada saem do índice da conversa (o servidor cuida); na tela ficam na lista, marcadas.
 */
export const DOC_STATUSES: readonly TDocStatus[] = ['proposed', 'accepted', 'superseded', 'archived']

/** O nome de cada status, no singular feminino ("proposta", "aceita"…). */
export const DOC_STATUS_LABEL: Record<TDocStatus, string> = { proposed: 'proposta', accepted: 'aceita', superseded: 'substituída', archived: 'arquivada' }

/** O filtro da lista: "Todas" ou um status. */
export type TDocStatusFilter = TDocStatus | 'all'

/** O plural de cada opção do filtro. */
export const DOC_STATUS_FILTER_LABEL: Record<TDocStatusFilter, string> = {
  all: 'Todas',
  accepted: 'Aceitas',
  proposed: 'Propostas',
  superseded: 'Substituídas',
  archived: 'Arquivadas',
}
export const DOC_STATUS_FILTERS: readonly TDocStatusFilter[] = ['all', 'accepted', 'proposed', 'superseded', 'archived']

/** As classes do selo de cada status (só os que se destacam; a aceita não tem selo). */
export const DOC_STATUS_BADGE: Partial<Record<TDocStatus, string>> = {
  proposed: 'bg-sky-500/15 text-sky-300',
  superseded: 'bg-amber-500/15 text-amber-300',
  archived: 'bg-zinc-700/50 text-zinc-400',
}

/** O status do documento (ausente = aceita). */
export const docStatusOf = (doc: { status?: TDocStatus }): TDocStatus => doc.status ?? 'accepted'

/** Substituída ou arquivada: fora do índice da conversa. */
export const isInactive = (status: TDocStatus): boolean => status === 'superseded' || status === 'archived'

/** Quantos documentos há de cada status (e `all`). */
export function statusCounts(docs: ReadonlyArray<{ status?: TDocStatus }>): Record<TDocStatusFilter, number> {
  const counts: Record<TDocStatusFilter, number> = { all: docs.length, accepted: 0, proposed: 0, superseded: 0, archived: 0 }
  for (const doc of docs) counts[docStatusOf(doc)]++
  return counts
}

/** Só os do status escolhido (`all` = todos). */
export const filterByStatus = <T extends { status?: TDocStatus }>(docs: readonly T[], filter: TDocStatusFilter): T[] =>
  filter === 'all' ? [...docs] : docs.filter((doc) => docStatusOf(doc) === filter)

/** As duas listas de ids têm os mesmos itens (a ordem não conta)? Ausente = vazia. */
export const sameIds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => [...(a ?? [])].sort().join(',') === [...(b ?? [])].sort().join(',')
