import { IImportScan, IInventoryItem, TInventoryKind } from './ImportInventory.Model'

/**
 * O TRABALHO DE IMPORTAÇÃO: uma varredura SALVA de um repositório do projeto num `HEAD`, com o estado de cada item
 * (`docs/integration/plano-importador.md`, PR 6). Reanalisar cria um trabalho novo que reaproveita o estado dos itens
 * pela chave.
 *
 * ⛔ Nada daqui grava no catálogo: até o L5 ganhar o import, o importador vai até `approved`. O histórico do catálogo
 * não cobre o trabalho: cada item tem o seu `by`/`at`.
 *
 * Os estados de um item:
 * - `pending`: a importar (o começo, e o "incluir");
 * - `drafting`: o construtor está escrevendo (PR 7);
 * - `review`: há rascunho a revisar (PR 7/8);
 * - `approved` | `rejected` | `skipped`: a decisão (aprovar e rejeitar são do PR 8; `skipped` é o "excluir");
 * - `applied`: gravado no catálogo (PR 9);
 * - `error`: o construtor falhou (PR 7);
 * - `stale`: a fonte mudou depois da última decisão (a reanálise marca; `staleFrom` diz o que era).
 */
export type TImportItemState = 'pending' | 'drafting' | 'review' | 'approved' | 'rejected' | 'skipped' | 'applied' | 'error' | 'stale'

export const IMPORT_ITEM_STATES: readonly TImportItemState[] = ['pending', 'drafting', 'review', 'approved', 'rejected', 'skipped', 'applied', 'error', 'stale']

/** O que a pessoa marca à mão neste PR: excluir (`skipped`) e incluir (`pending`). O resto vem com o construtor e a revisão. */
export type TImportManualState = 'pending' | 'skipped'

export const IMPORT_MANUAL_STATES: readonly TImportManualState[] = ['pending', 'skipped']

/** O estado de um item no trabalho: o que persiste além do inventário. */
export interface IImportItemStatus {
  key: string
  state: TImportItemState
  /** `stale`: o estado antes de a fonte mudar. */
  staleFrom?: TImportItemState
  /** A reclassificação da pessoa (ausente = o tipo detectado). */
  kind?: TInventoryKind
  /** As fontes do item NESTE trabalho (caminho + sha256), resumidas num hash. */
  fingerprint: string
  /** As fontes quando a última decisão foi tomada: a reanálise compara com elas. Ausente = nenhuma decisão. */
  basis?: string
  /** O id no gateway (mapa de ids; PR 7). */
  targetId?: string
  /** A conversa do construtor (PR 7). */
  conversationId?: string
  /** Os rascunhos que passaram na conferência (PR 7). */
  drafts: unknown[]
  /** A revisão do item (PR 8). */
  review?: unknown
  approvedBy?: string
  approvedAt?: Date
  /** O lote do catálogo em que entrou (PR 9). */
  batchId?: string
  /** Quem mudou o item por último, e quando (estado ou reclassificação). */
  by?: string
  at?: Date
}

/** Um item do trabalho: o do inventário e o estado. */
export interface IImportJobItem extends IImportItemStatus {
  item: IInventoryItem
}

/** O que a reanálise fez com os itens do trabalho anterior do mesmo repositório. */
export interface IImportReuse {
  /** O trabalho de onde o estado veio. */
  from: string
  /** Fonte igual: o estado veio como estava. */
  kept: number
  /** Fonte mudada depois da decisão: virou `stale`. */
  stale: string[]
  /** Estava `stale` e a fonte voltou a ser a da decisão: o estado de antes voltou. */
  restored: string[]
  /** Itens que o trabalho anterior não tinha. */
  added: string[]
  /** Itens do trabalho anterior que sumiram. */
  gone: string[]
}

/** O cabeçalho de um trabalho: a linha da lista. */
export interface IImportJobSummary {
  id: string
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  /** Quem analisou. */
  by: string
  /** O trabalho anterior do mesmo repositório, de onde o estado foi reaproveitado. */
  previousId?: string
  /** Quantos itens, e quantos em cada estado. */
  items: number
  byState: Partial<Record<TImportItemState, number>>
  /** É o trabalho mais novo do repositório: só ele muda (os outros são registro). */
  latest: boolean
  reuse?: IImportReuse
}

/** O trabalho aberto: o inventário inteiro (como a varredura devolve) e o estado de cada item. */
export interface IImportJob extends IImportJobSummary {
  scan: IImportScan
  states: Array<Omit<IImportItemStatus, 'basis'>>
}

/** O que o repositório guarda de um trabalho novo. */
export interface INewImportJob {
  id: string
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  by: string
  previousId?: string
  /** O inventário sem os itens (formatos, totais, ignorados). */
  inventory: Omit<IImportScan, 'items'>
  reuse?: IImportReuse
  items: IImportJobItem[]
}

/** A mudança de um item: o estado, a reclassificação (`null` volta ao detectado), e o que mais a regra decidiu. */
export type TImportItemPatch = Partial<Pick<IImportItemStatus, 'state' | 'basis' | 'by' | 'at' | 'conversationId' | 'drafts' | 'approvedBy' | 'approvedAt'>> & {
  kind?: TInventoryKind | null
  staleFrom?: TImportItemState | null
  /** A revisão (`null` apaga). */
  review?: IImportReview | null
}

/**
 * A REVISÃO de um rascunho (PR 7, mínima): os OKs de cada remoção (pelo índice da operação) e o pedido de ajuste, que
 * volta à conversa do construtor.
 */
export interface IImportReview {
  /** As remoções com OK, pelo índice da operação no rascunho. */
  removals?: number[]
  /** O pedido de ajuste: o comentário vai para a conversa (o construtor o lê nos itens dela). */
  adjust?: { comment: string; by: string; at: string }
  by?: string
  at?: string
}

/**
 * Um LOTE SALVO no trabalho: a seleção da pessoa, com nome, a ordem calculada ao montar, o prefixo, quem e quando.
 * ⛔ Salvar o lote não dispara nada nem grava no catálogo: é o registro do que a pessoa quer importar junto.
 * O lote é do trabalho: reanalisar o repositório cria um trabalho novo, sem lotes.
 */
export interface IImportBatch {
  id: string
  jobId: string
  name: string
  prefix: string
  /** As chaves escolhidas, como vieram. */
  keys: string[]
  /** A ordem calculada ao montar (só os que têm conversa de construtor, já feitos inclusos). */
  order: string[]
  by: string
  at: Date
}
