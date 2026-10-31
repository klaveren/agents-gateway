import { api, ApiError } from '@/lib/api'
import { BUILD_KINDS, type TBuildKind } from '@/lib/builder'

/**
 * O HISTÓRICO DO CATÁLOGO na tela: os tipos e as chamadas de `/v1/catalog/history` e do rollback (ver
 * docs/integration/plano-catalogo-historico.md, PR 6). ⛔ Só admin lê tudo; o membro, só o MCP do projeto dele — e não
 * restaura (as rotas de escrita respondem 404 para ele).
 */

export type TCatalogKind = 'agent' | 'skill' | 'command' | 'rule' | 'spec' | 'adr' | 'knowledge' | 'protocol' | 'project' | 'project-permissions' | 'mcp'
export type TRevisionOp = 'baseline' | 'create' | 'update' | 'delete' | 'restore' | 'import' | 'drift'
export type TRevisionSource = 'api' | 'agent' | 'migration' | 'boot' | 'import' | 'restore'

/** Uma linha da lista: a revisão sem o documento. */
export interface IRevisionSummary {
  id: number
  kind: TCatalogKind
  itemId: string
  projectId?: string
  revision: number
  op: TRevisionOp
  hash?: string
  at: string
  by: string
  source: TRevisionSource
  batchId?: string
  note?: string
  /** As chaves das ampliações que quem gravou aceitou. */
  widenings?: string[]
}

export interface IRevisionPage {
  revisions: IRevisionSummary[]
  total: number
  page: number
  pageSize: number
}

export interface IItemHistory extends IRevisionPage {
  kind: TCatalogKind
  itemId: string
  current: { exists: boolean; hash?: string }
}

export interface IScopeHistory extends IRevisionPage {
  scope: string
}

export type TDiffOp = 'equal' | 'add' | 'remove'

export interface IDiffLine {
  op: TDiffOp
  text: string
  oldLine?: number
  newLine?: number
  noNewline?: true
}

export interface IDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: IDiffLine[]
}

export interface IDiffSide {
  revision: number | 'current'
  exists: boolean
  hash?: string
  op?: TRevisionOp
  at?: string
  by?: string
}

export interface IRevisionDiff {
  kind: TCatalogKind
  itemId: string
  from: IDiffSide
  to: IDiffSide
  equal: boolean
  added: number
  removed: number
  hunks: IDiffHunk[]
  unified: string
}

export interface IWideningRef {
  key: string
  description: string
}

export interface IRestoreResult {
  kind: TCatalogKind
  itemId: string
  restoredFrom: number
  unchanged: boolean
  exists: boolean
  revision?: IRevisionSummary
  alsoChanged: IRevisionSummary[]
  widenings: IWideningRef[]
  missingSecrets: string[]
}

interface IRevertItem {
  ref: string
  kind: TCatalogKind
  itemId: string
  toRevision: number
}

export interface IRevertResult {
  batch: { id: string; status: 'applied' | 'partial' | 'reverted' }
  reverted: Array<IRevertItem & { revision?: number; missingSecrets: string[] }>
  unchanged: IRevertItem[]
  conflicts: Array<IRevertItem & { currentRevision: number }>
  failed?: IRevertItem & { message: string; issues?: IIssue[] }
}

export type TBatchStatus = 'applied' | 'partial' | 'reverted'

/** Um lote (import ou reversão): o registro de `catalog_batches`, com quantos itens ele tocou. */
export interface IBatch {
  id: string
  at: string
  by: string
  kind: 'import' | 'revert'
  scope: string
  /** O que o lote gravou, pulou, onde parou (`failed`), o que ficou pendente (`pending`). JSON livre de quem grava. */
  summary: Record<string, unknown>
  /** As ampliações aceitas, item a item. */
  widenings: Array<IWideningRef & { kind: TCatalogKind; itemId: string }>
  status: TBatchStatus
  items: number
}

export interface IBatchPage {
  batches: IBatch[]
  total: number
  page: number
  pageSize: number
}

export const BATCH_STATUS_LABEL: Readonly<Record<TBatchStatus, string>> = { applied: 'aplicado', partial: 'parcial', reverted: 'revertido' }
export const BATCH_KIND_LABEL: Readonly<Record<IBatch['kind'], string>> = { import: 'importação', revert: 'reversão' }

/** Os lotes: `project` é um id, `global`, ou ausente (todos). */
export function listBatches(project: string | undefined, page = 1, pageSize = HISTORY_PAGE_SIZE): Promise<IBatchPage> {
  return api<IBatchPage>('/catalog/batches', { query: { project, page, pageSize } })
}

export interface IIssue {
  field: string
  message: string
}

/** O item: `id` é o do histórico (no MCP, a chave `<projeto>.<id>`; no complemento, `<projeto>/<tipo>`). */
export interface IHistoryRef {
  kind: TCatalogKind
  id: string
}

export const HISTORY_PAGE_SIZE = 20

export const OP_LABEL: Readonly<Record<TRevisionOp, string>> = {
  baseline: 'estado inicial',
  create: 'criado',
  update: 'alterado',
  delete: 'apagado',
  restore: 'restaurado',
  import: 'importado',
  drift: 'mudou por fora',
}

export const SOURCE_LABEL: Readonly<Record<TRevisionSource, string>> = {
  api: 'tela ou API',
  agent: 'agente',
  migration: 'migração',
  boot: 'início do servidor',
  import: 'importação',
  restore: 'restauração',
}

export const KIND_LABEL: Readonly<Record<TCatalogKind, string>> = {
  agent: 'Agente',
  skill: 'Skill',
  command: 'Command',
  rule: 'Rule',
  spec: 'Spec',
  adr: 'ADR',
  knowledge: 'Conhecimento',
  protocol: 'Complemento de protocolo',
  project: 'Projeto',
  'project-permissions': 'Permissões do projeto',
  mcp: 'MCP',
}

export function itemHistory(ref: IHistoryRef, page = 1, pageSize = HISTORY_PAGE_SIZE): Promise<IItemHistory> {
  return api<IItemHistory>('/catalog/history', { query: { kind: ref.kind, id: ref.id, page, pageSize } })
}

/** `project`: um id, `global`, ou ausente (tudo, só admin). */
export function scopeHistory(project: string | undefined, page = 1, pageSize = HISTORY_PAGE_SIZE): Promise<IScopeHistory> {
  return api<IScopeHistory>('/catalog/history', { query: { project, page, pageSize } })
}

/** O diff: `from`/`to` são revisões (`0` = antes de existir) ou `current`. */
export function revisionDiff(ref: IHistoryRef, from: number | 'current', to: number | 'current'): Promise<IRevisionDiff> {
  return api<IRevisionDiff>('/catalog/history/diff', { query: { kind: ref.kind, id: ref.id, from, to } })
}

export function restoreRevision(ref: IHistoryRef, revision: number, expectedRevision: number, confirm?: string[]): Promise<IRestoreResult> {
  return api<IRestoreResult>('/catalog/history/restore', {
    method: 'POST',
    body: { kind: ref.kind, id: ref.id, revision, expectedRevision, ...(confirm ? { confirm } : {}) },
  })
}

export function revertBatch(batchId: string, options: { confirm?: string[]; overwrite?: string[] } = {}): Promise<IRevertResult> {
  return api<IRevertResult>(`/catalog/batches/${encodeURIComponent(batchId)}/revert`, { method: 'POST', body: options })
}

/** O que a falha de uma escrita (restaurar, reverter) pede da tela. */
export type TWriteFailure =
  | { type: 'conflict'; message: string }
  | { type: 'widening'; widenings: IWideningRef[] }
  | { type: 'forbidden'; message: string; widenings: IWideningRef[] }
  | { type: 'invalid'; issues: IIssue[] }
  | { type: 'other'; message: string }

export function classifyFailure(failure: unknown): TWriteFailure {
  if (!(failure instanceof ApiError)) return { type: 'other', message: failure instanceof Error ? failure.message : String(failure) }
  const details = (failure.details ?? {}) as { widenings?: IWideningRef[] }
  if (failure.status === 409 && failure.code === 'widening_confirmation_required') return { type: 'widening', widenings: details.widenings ?? [] }
  if (failure.status === 409) return { type: 'conflict', message: failure.message }
  if (failure.status === 403 && Array.isArray(details.widenings)) return { type: 'forbidden', message: failure.message, widenings: details.widenings }
  if (failure.status === 422) {
    const issues = Array.isArray(failure.details) ? (failure.details as IIssue[]) : []
    return { type: 'invalid', issues: issues.length ? issues : [{ field: '', message: failure.message }] }
  }
  return { type: 'other', message: failure.message }
}

/** Onde o item é editado na tela, abrindo a guia Histórico (`#historico`). `undefined` = sem tela. */
export function itemLink(revision: Pick<IRevisionSummary, 'kind' | 'itemId' | 'projectId'>): string | undefined {
  const id = encodeURIComponent(revision.itemId)
  switch (revision.kind) {
    case 'agent':
      return `/agents/${id}#historico`
    case 'skill':
      return `/skills/${id}#historico`
    case 'command':
      return `/commands/${id}#historico`
    case 'spec':
      return `/specs/${id}#historico`
    case 'adr':
      return `/adrs/${id}#historico`
    case 'knowledge':
      return `/knowledge/${id}#historico`
    case 'mcp':
      return `/mcp/${id}#historico`
    case 'rule':
      return `/rules?escopo=${encodeURIComponent(revision.projectId || 'global')}&rule=${id}#historico`
    case 'project-permissions':
      return `/permissions?projeto=${id}#historico`
    case 'protocol': {
      const kind = (revision.itemId.includes('/') ? revision.itemId.slice(revision.itemId.indexOf('/') + 1) : revision.itemId) as TBuildKind
      return BUILD_KINDS[kind] ? `${BUILD_KINDS[kind].base}/protocol` : undefined
    }
    case 'project':
      return `/projects/${id}`
  }
}
