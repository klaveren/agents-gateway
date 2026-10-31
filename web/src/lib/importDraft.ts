import { BUILD_KINDS, type TBuildKind } from './builder'
import type { IImportItemStatus, TImportItemState, TInventoryKind } from './importer'

/**
 * O RASCUNHO DE IMPORTAÇÃO (no gateway, `Import.Draft`): a fonte + operações de tipos fixos, aplicadas pelo servidor. A
 * tela mostra os metadados, as operações (as remoções pedem OK uma a uma) e o diff fonte × final. ⛔ Aprovar não grava no
 * catálogo: só muda o estado do item para `approved`.
 */
export type TImportOpType = 'setMeta' | 'linkCitation' | 'heading' | 'split' | 'remove' | 'compose'

export interface IImportOp {
  op: TImportOpType
  field?: string
  value?: string
  source?: string
  text?: string
  occurrence?: number
  target?: string
  link?: 'attach' | 'reference' | 'initialContext'
  level?: number
  meta?: Record<string, string>
  whole?: boolean
  reason?: string
  into?: 'body' | 'soul' | 'systemPrompt'
  sources?: string[]
}

export interface IDiffLine {
  op: 'equal' | 'add' | 'remove'
  text: string
  oldLine?: number
  newLine?: number
}

export interface IDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: IDiffLine[]
}

export interface ITextDiff {
  equal: boolean
  added: number
  removed: number
  hunks: IDiffHunk[]
}

export interface IImportDraftView {
  key: string
  kind: TBuildKind | 'trigger'
  sources: Array<{ path: string; sha256: string }>
  ops: IImportOp[]
  meta: Record<string, string>
  outputs: Array<{ from: 'main' | 'split'; meta: Record<string, string>; fields: Partial<Record<'body' | 'soul' | 'systemPrompt', string>> }>
  links: Array<{ op: number; source: string; text: string; target: string; link: string }>
  removals: Array<{ op: number; source: string; text: string; whole: boolean; reason: string }>
  diffs: Array<{ source: string; diff: ITextDiff }>
  conversationId: string
  proposedAt: string
}

export interface IImportReviewView {
  removals?: number[]
  adjust?: { comment: string; by: string; at: string }
  by?: string
  at?: string
}

/** O estado do item com o que o construtor e a revisão gravam. */
export type IImportBuildStatus = IImportItemStatus & {
  conversationId?: string
  drafts?: unknown[]
  review?: IImportReviewView
  approvedBy?: string
  approvedAt?: string
}

export const OP_LABEL: Record<TImportOpType, string> = {
  setMeta: 'metadado',
  linkCitation: 'citação → vínculo',
  heading: 'nível de título',
  split: 'dividir',
  remove: 'remover',
  compose: 'juntar fontes',
}

export const LINK_LABEL: Record<string, string> = { attach: 'anexo inteiro', reference: 'anexo por referência', initialContext: 'contexto inicial' }

/** O rascunho em vigor do item (o último que passou na conferência). */
export function lastDraft(status: IImportBuildStatus | undefined): IImportDraftView | undefined {
  const draft = status?.drafts?.at(-1)
  return draft && typeof draft === 'object' && Array.isArray((draft as IImportDraftView).ops) ? (draft as IImportDraftView) : undefined
}

/** As remoções ainda sem OK (pelo índice da operação). Vazio = pode aprovar. */
export function missingOks(draft: Pick<IImportDraftView, 'removals'>, oks: ReadonlySet<number>): number[] {
  return draft.removals.map((removal) => removal.op).filter((op) => !oks.has(op))
}

/** Uma linha que diz o que a operação faz (a remoção mostra o trecho à parte). */
export function opSummary(op: IImportOp): string {
  const where = op.source ? ` em ${op.source}` : ''
  const nth = op.occurrence ? ` (ocorrência ${op.occurrence})` : ''
  switch (op.op) {
    case 'setMeta':
      return `${op.field} = ${op.value}`
    case 'linkCitation':
      return `${op.text} → ${op.target} (${LINK_LABEL[op.link ?? ''] ?? op.link})${where}${nth}`
    case 'heading':
      return `${op.text} → nível ${op.level}${where}${nth}`
    case 'split':
      return `${op.text} vira outro item: ${op.meta?.id ?? op.meta?.title ?? '?'}${where}${nth}`
    case 'remove':
      return op.whole ? `a fonte inteira ${op.source}` : `trecho${where}${nth}`
    case 'compose':
      return `${op.into} ← ${(op.sources ?? []).join(' + ')}`
  }
}

/** O construtor que importa cada tipo do inventário (o trigger vai ao de agentes). */
export function builderKindFor(kind: TInventoryKind): TBuildKind | undefined {
  if (kind === 'trigger') return 'agent'
  return kind in BUILD_KINDS ? (kind as TBuildKind) : undefined
}

/** Os estados de onde o item pode ir (ou voltar) ao construtor. */
export const BUILDABLE_STATES: readonly TImportItemState[] = ['pending', 'drafting', 'review', 'rejected', 'error', 'stale']

/** A tela da conversa do construtor (a guia Construir do tipo, com a conversa aberta). */
export function buildLink(kind: TBuildKind, conversationId: string): string {
  return `${BUILD_KINDS[kind].base}/build?c=${encodeURIComponent(conversationId)}`
}

/** A primeira mensagem sugerida da conversa de importação (a pessoa manda quando quiser). */
export function importOpening(keys: readonly string[]): string {
  return `Importe ${keys.length === 1 ? 'este item' : `estes ${keys.length} itens`} do trabalho de importação: ${keys.join(', ')}. Comece por list_import_items, leia as fontes e me pergunte o que for ambíguo.`
}
