import { createHash } from 'node:crypto'
import { IImportAnalysis, IImportItemStatus, TImportItemPatch, TImportItemState } from './models/ImportJob.Model'
import { IInventoryItem } from './models/ImportInventory.Model'

/**
 * As regras do TRABALHO DE IMPORTAÇÃO, puras (`docs/integration/plano-importador.md`, PR 6): as transições de estado de
 * um item, quando a reclassificação vale e o que a reanálise (na mesma importação) faz com cada item.
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

/**
 * Reclassificar só sem rascunho no caminho: com rascunho a revisar, aprovado ou aplicado, não. O item no construtor
 * (`drafting`) AINDA SEM RASCUNHO também (`drafted: false`): ele sai da conversa e volta a `pending`, para o construtor
 * do tipo novo.
 */
export const RECLASSIFIABLE_STATES: readonly TImportItemState[] = ['pending', 'skipped', 'rejected', 'error', 'stale']

export function canReclassify(state: TImportItemState, drafted = true): boolean {
  return RECLASSIFIABLE_STATES.includes(state) || (state === 'drafting' && !drafted)
}

/** O item que sai da conversa do construtor (sem rascunho) e volta à fila. */
export function releasedFromBuilder(fingerprint: string): TImportItemPatch {
  return { state: 'pending', conversationId: null, review: null, staleFrom: null, basis: fingerprint }
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

/** O registro da análise, a partir do que cada item virou, das chaves que saíram e das que voltaram. */
export function analysisOf(
  header: Pick<IImportAnalysis, 'at' | 'by' | 'head' | 'dirty'>,
  outcomes: ReadonlyArray<{ key: string; outcome: TCarryOutcome }>,
  gone: readonly string[],
  returned: readonly string[],
): IImportAnalysis {
  const pick = (outcome: TCarryOutcome) => outcomes.filter((entry) => entry.outcome === outcome).map((entry) => entry.key)
  return {
    at: header.at,
    by: header.by,
    ...(header.head ? { head: header.head } : {}),
    ...(header.dirty !== undefined ? { dirty: header.dirty } : {}),
    kept: pick('kept').length,
    stale: pick('stale'),
    added: pick('added'),
    gone: [...gone],
    restored: pick('restored'),
    returned: [...returned],
  }
}

/** O item já foi PROCESSADO: tem decisão, conversa de construtor, rascunho ou revisão. */
export function isProcessed(entry: Pick<IImportItemStatus, 'state' | 'conversationId' | 'drafts' | 'review'>): boolean {
  return entry.state !== 'pending' || !!entry.conversationId || entry.drafts.length > 0 || entry.review !== undefined
}

/**
 * A CONSOLIDAÇÃO de um item (a migração de "um trabalho por análise" para "uma importação por repositório"): o item da
 * importação que fica, ou o de uma análise antiga que sabe MAIS. ⛔ O processado da importação nunca é sobrescrito; o da
 * antiga só entra se a de agora não tem nada, com as regras de `carryOver` (fonte mudada desde a decisão: `stale`).
 * Devolve o item como deve ficar, ou `undefined` (fica como está).
 */
export function consolidatedItem<T extends IImportItemStatus>(current: T, older: readonly IImportItemStatus[]): T | undefined {
  if (isProcessed(current)) return undefined
  const source = older.find(isProcessed)
  if (!source) return undefined
  const carried = carryOver(source, current.fingerprint)
  // ⚖️ Só o que é do processamento: o inventário (`item`), a fonte e a marca de saída são os da importação que fica.
  const copied: Partial<IImportItemStatus> = {}
  for (const field of PROCESSED_FIELDS) if (source[field] !== undefined) Object.assign(copied, { [field]: source[field] })
  const { staleFrom: _staleFrom, ...rest } = current
  return {
    ...rest,
    ...copied,
    basis: source.basis ?? source.fingerprint,
    state: carried.state,
    ...(carried.staleFrom ? { staleFrom: carried.staleFrom } : {}),
  } as T
}

/** O que a consolidação leva de uma análise antiga para a importação que fica. */
const PROCESSED_FIELDS = ['kind', 'targetId', 'conversationId', 'drafts', 'review', 'approvedBy', 'approvedAt', 'batchId', 'by', 'at'] as const

/** Quantos itens em cada estado. */
export function countByState(states: ReadonlyArray<{ state: TImportItemState }>): Partial<Record<TImportItemState, number>> {
  const out: Partial<Record<TImportItemState, number>> = {}
  for (const { state } of states) out[state] = (out[state] ?? 0) + 1
  return out
}
