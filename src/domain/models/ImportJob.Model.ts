import { IImportScan, IInventoryItem, TInventoryKind } from './ImportInventory.Model'

/**
 * O TRABALHO DE IMPORTAÇÃO: uma varredura SALVA de um repositório do projeto num `HEAD`, com o estado de cada item
 * (`docs/integration/plano-importador.md`, PR 6). ⚖️ UMA importação por repositório do projeto: reanalisar ATUALIZA a
 * mesma (inventário, `HEAD`, data), o id não muda; o estado de cada item fica, com as regras de `carryOver`.
 *
 * ⛔ Nada daqui grava no catálogo: quem grava é a gravação pelo catálogo (`ImportApply.Usecase`, PR 9), com o clique
 * e as confirmações da pessoa; o item aplicado guarda o lote do catálogo (`batchId`). O histórico do catálogo não cobre
 * o trabalho: cada item tem o seu `by`/`at`.
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
  /**
   * IMPORTADO FORA DO IMPORTADOR: um agente gravou o item no catálogo (`save_*` com `importedFrom`) e avisou. O item
   * fica `applied`, sem lote, com o que nasceu dele e quem gravou. ⚖️ É registro, não decisão de ninguém.
   */
  importedBy?: IImportedBy
  /** Quem mudou o item por último, e quando (estado ou reclassificação). */
  by?: string
  at?: Date
  /**
   * SAIU DA FONTE: a análise de quando o item deixou de aparecer no repositório. ⚖️ Não é estado: o item fica como
   * estava (rascunho, aprovação, lote), fora do construtor e da gravação; volta sozinho se a fonte voltar. ⛔ O catálogo
   * não é tocado.
   */
  goneAt?: Date
}

/** Quem gravou o item fora do importador, e o que nasceu dele no catálogo. */
export interface IImportedBy {
  /** O item do catálogo: o tipo e o id. */
  kind: string
  id: string
  /** O agente e a conversa que gravaram (ausentes quando a pessoa grava direto pela API). */
  agentId?: string
  conversationId?: string
  /** Uma fonte que virou VÁRIOS itens (um arquivo com dezenas de ADRs): todos, na ordem em que foram gravados. */
  targets?: Array<{ kind: string; id: string }>
}

/** Um item do trabalho: o do inventário e o estado. */
export interface IImportJobItem extends IImportItemStatus {
  item: IInventoryItem
}

/** O REGISTRO de uma análise: quando, quem, o `HEAD`, e o que mudou nos itens da importação. */
export interface IImportAnalysis {
  at: Date
  by: string
  head?: string
  dirty?: boolean
  /** Fonte igual (ou nada decidido): o item ficou como estava. */
  kept: number
  /** Fonte mudada depois da decisão: virou `stale`. */
  stale: string[]
  /** Itens novos na fonte. */
  added: string[]
  /** Itens que saíram da fonte NESTA análise. */
  gone: string[]
  /** Estava `stale` e a fonte voltou a ser a da decisão: o estado de antes voltou. */
  restored: string[]
  /** Tinham saído da fonte e voltaram. */
  returned: string[]
}

/** O cabeçalho de um trabalho: a linha da lista. */
export interface IImportJobSummary {
  id: string
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  /** Quem analisou por último. */
  by: string
  /** Quantos itens, e quantos em cada estado (os que saíram da fonte contam no estado deles). */
  items: number
  byState: Partial<Record<TImportItemState, number>>
  /** Quantos saíram da fonte. */
  gone: number
  /** ⚖️ Sempre `true`: a importação é a única do repositório (o campo fica para quem ainda o lê). */
  latest: boolean
  /** As últimas análises, da mais nova à mais velha. */
  analyses: IImportAnalysis[]
}

/** O trabalho aberto: o inventário inteiro (como a varredura devolve) e o estado de cada item. */
export interface IImportJob extends IImportJobSummary {
  scan: IImportScan
  states: Array<Omit<IImportItemStatus, 'basis'>>
}

/** O que o repositório guarda de um trabalho novo (a primeira análise do repositório). */
export interface INewImportJob {
  id: string
  projectId: string
  repository: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  by: string
  /** O inventário sem os itens (formatos, totais, ignorados). */
  inventory: Omit<IImportScan, 'items'>
  items: IImportJobItem[]
  /** O registro da análise. */
  analysis?: IImportAnalysis
}

/** Um item na reanálise: o do inventário de agora e, quando a regra mudou, o estado. */
export interface IImportItemRefresh {
  key: string
  item: IInventoryItem
  fingerprint: string
  /** Mudou com a fonte (`stale`, ou de volta ao estado de antes); ausente = o estado fica. */
  state?: TImportItemState
  staleFrom?: TImportItemState | null
}

/**
 * A REANÁLISE gravada na mesma importação, de uma vez: o cabeçalho (`HEAD`, data, quem, inventário), os itens que estão
 * na fonte (os novos entram `pending`), os que saíram (marcados, não apagados) e o registro.
 */
export interface IImportReanalysis {
  jobId: string
  head?: string
  dirty?: boolean
  scannedAt: Date
  by: string
  inventory: Omit<IImportScan, 'items'>
  present: IImportItemRefresh[]
  gone: string[]
  analysis: IImportAnalysis
}

/** A mudança de um item: o estado, a reclassificação (`null` volta ao detectado), e o que mais a regra decidiu. */
export type TImportItemPatch = Partial<Pick<IImportItemStatus, 'state' | 'basis' | 'by' | 'at' | 'drafts' | 'approvedBy' | 'approvedAt' | 'batchId' | 'importedBy'>> & {
  /** A conversa do construtor (`null` solta o item dela). */
  conversationId?: string | null
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
 * O lote é da importação e sobrevive à reanálise; a chave que saiu da fonte continua nele, marcada (`gone`).
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
  /** Na leitura: as chaves do lote cujo item saiu da fonte (ou não está na importação). */
  gone?: string[]
}
