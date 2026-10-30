import { createHash } from 'node:crypto'
import { IImportItemStatus, IImportReuse, TImportItemState } from './models/ImportJob.Model'
import { IInventoryItem } from './models/ImportInventory.Model'

/**
 * As regras do TRABALHO DE IMPORTAÇÃO, puras (`docs/integration/plano-importador.md`, PR 6): as transições de estado de
 * um item, quando a reclassificação vale e o reaproveitamento na reanálise.
 *
 * ⛔ Nada daqui grava no catálogo nem dispara construtor: o dono opera item a item, à mão.
 */

/**
 * As transições de um item. A reanálise não passa por aqui: ela marca `stale` (e desfaz o `stale`) sozinha.
 * - `pending` → o construtor começa, ou a pessoa exclui;
 * - `drafting` → o rascunho chega, o construtor falha, ou a fila é cancelada;
 * - `review` → aprovar, rejeitar, pular, ou pedir ajuste (volta ao construtor);
 * - `approved` → gravado pelo catálogo, ou de volta à revisão;
 * - `rejected`/`error`/`stale` → de novo à fila, ao construtor, ou fora;
 * - `skipped` → incluir de novo;
 * - `applied` → só a reanálise mexe (fonte mudada vira `stale`).
 */
export const IMPORT_TRANSITIONS: Readonly<Record<TImportItemState, readonly TImportItemState[]>> = {
  pending: ['drafting', 'skipped'],
  drafting: ['review', 'error', 'pending'],
  review: ['approved', 'rejected', 'skipped', 'drafting'],
  approved: ['applied', 'review'],
  rejected: ['pending', 'drafting', 'skipped'],
  skipped: ['pending'],
  applied: [],
  error: ['pending', 'drafting', 'skipped'],
  stale: ['pending', 'drafting', 'skipped'],
}

export function canTransition(from: TImportItemState, to: TImportItemState): boolean {
  return IMPORT_TRANSITIONS[from].includes(to)
}

/** Reclassificar só sem rascunho no caminho: com construtor rodando, rascunho a revisar, aprovado ou aplicado, não. */
export const RECLASSIFIABLE_STATES: readonly TImportItemState[] = ['pending', 'skipped', 'rejected', 'error', 'stale']

export function canReclassify(state: TImportItemState): boolean {
  return RECLASSIFIABLE_STATES.includes(state)
}

/**
 * As fontes do item resumidas num hash: o caminho e o `sha256` de cada uma, em ordem. Fonte nova, sumida ou com
 * conteúdo diferente muda o resumo; o mesmo arquivo achado por outro link (alias) não muda.
 */
export function sourceFingerprint(item: Pick<IInventoryItem, 'sources'>): string {
  const lines = item.sources.map((source) => `${source.path}\0${source.sha256}`).sort()
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

export type TCarryOutcome = 'added' | 'kept' | 'stale' | 'restored'

export interface ICarried {
  outcome: TCarryOutcome
  state: TImportItemState
  staleFrom?: TImportItemState
}

/**
 * O REAPROVEITAMENTO de um item na reanálise, pela chave:
 * - item novo: `pending`;
 * - `pending` (nada decidido): continua `pending`, mude a fonte ou não;
 * - fonte igual à da última decisão (`basis`): o estado vem como estava; um `stale` cuja fonte voltou a ser a da decisão
 *   recupera o estado de antes;
 * - fonte diferente da da última decisão: `stale`, lembrando o estado de antes (`staleFrom`). Um `stale` continua `stale`
 *   com o mesmo `staleFrom`.
 *
 * ⚖️ A comparação é com a fonte DA DECISÃO, não com a da análise anterior: duas reanálises seguidas com a fonte mudada
 * não "limpam" a marca.
 */
export function carryOver(previous: Pick<IImportItemStatus, 'state' | 'staleFrom' | 'basis' | 'fingerprint'> | undefined, fingerprint: string): ICarried {
  if (!previous) return { outcome: 'added', state: 'pending' }
  if (previous.state === 'pending') return { outcome: 'kept', state: 'pending' }
  const basis = previous.basis ?? previous.fingerprint
  if (basis === fingerprint) {
    if (previous.state === 'stale') return { outcome: 'restored', state: previous.staleFrom ?? 'pending' }
    return { outcome: 'kept', state: previous.state }
  }
  const from = previous.state === 'stale' ? previous.staleFrom : previous.state
  return { outcome: 'stale', state: 'stale', ...(from ? { staleFrom: from } : {}) }
}

/** O resumo da reanálise, a partir do que cada item virou e das chaves que sumiram. */
export function reuseSummary(from: string, outcomes: ReadonlyArray<{ key: string; outcome: TCarryOutcome }>, gone: readonly string[]): IImportReuse {
  const pick = (outcome: TCarryOutcome) => outcomes.filter((entry) => entry.outcome === outcome).map((entry) => entry.key)
  return { from, kept: pick('kept').length, stale: pick('stale'), restored: pick('restored'), added: pick('added'), gone: [...gone] }
}

/** Quantos itens em cada estado. */
export function countByState(states: ReadonlyArray<{ state: TImportItemState }>): Partial<Record<TImportItemState, number>> {
  const out: Partial<Record<TImportItemState, number>> = {}
  for (const { state } of states) out[state] = (out[state] ?? 0) + 1
  return out
}
