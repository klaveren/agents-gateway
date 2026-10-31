import { api, ApiError } from '@/lib/api'
import type { IDiffHunk, IIssue, IWideningRef, TCatalogKind } from '@/lib/catalogHistory'

/**
 * A GRAVAÇÃO DO IMPORTADOR na tela: a prévia (`apply/plan`) e o gravar (`apply`) de um trabalho de importação (ver
 * docs/integration/plano-importador.md, PR 9). ⛔ Nada grava sem o clique e sem uma caixa marcada por ampliação.
 */

/** O que a pessoa escolhe: o lote salvo, ou as chaves (nenhum: todos os aprovados), as regras amplas incluídas e o modelo. */
export interface IApplySelection {
  batchId?: string
  keys?: string[]
  wide?: Record<string, string[]>
  models?: Record<string, { provider: string; model: string }>
}

export type TPlanOp = 'create' | 'update' | 'unchanged' | 'conflict' | 'error' | 'delete'

export interface IApplyPlanItem {
  ref: string
  kind: TCatalogKind
  id: string
  projectId?: string
  op: TPlanOp
  diff?: { hunks: IDiffHunk[]; added?: number; removed?: number }
  widenings: IWideningRef[]
  attentions: Array<{ key: string; description: string }>
  issues: IIssue[]
  brokenRefs: Array<{ from: string; message: string; reason: string }>
  missingSecrets?: string[]
  entersDisabled?: true
}

export interface IApplyPlan {
  scope: string
  planHash: string
  items: IApplyPlanItem[]
  order: Array<{ ref: string; phase: string; part?: 'record' | 'links' | 'reach'; widens: boolean }>
  widenings: Array<IWideningRef & { kind?: TCatalogKind; id?: string }>
  attentions: Array<{ key: string; description: string }>
  brokenRefs: Array<{ from: string; message: string; reason: string }>
  missingSecrets: Array<{ ref: string; secrets: string[] }>
  summary: Record<string, number>
}

export interface IApplyRule {
  key: string
  rule: { category: string; pattern: string; decision: string; note?: string }
  wide?: string
  included: boolean
}

export interface IApplyAgent {
  key: string
  id: string
  exists: boolean
  model?: { provider: string; model: string }
  rules: IApplyRule[]
  allowedTools: string[]
  skills: string[]
  pendingSkills: string[]
  commands: string[]
  reach: 'opencode' | 'none'
  notes: string[]
}

export interface IApplyPreview {
  jobId: string
  repository: string
  head?: string
  scope: string
  items: Array<{ key: string; kind: string; refs: string[] }>
  skipped: Array<{ key: string; reason: string }>
  agents: IApplyAgent[]
  models: Array<{ provider: string; models: string[] }>
  plan: IApplyPlan
}

export interface IApplyResult {
  planHash: string
  batch?: { id: string; status: 'applied' | 'partial' | 'reverted' }
  applied: Array<{ ref: string; part?: string }>
  failed?: { ref: string; part?: string; message: string; issues?: IIssue[] }
  pending: Array<{ ref: string; part?: string }>
  entersDisabled: string[]
  missingSecrets: Array<{ ref: string; secrets: string[] }>
  revert?: { batchId: string; path: string }
  items: { applied: string[]; notApplied: string[] }
}

const jobPath = (projectId: string, jobId: string) => `/projects/${encodeURIComponent(projectId)}/import/jobs/${encodeURIComponent(jobId)}`

export function previewApply(projectId: string, jobId: string, selection: IApplySelection): Promise<IApplyPreview> {
  return api<IApplyPreview>(`${jobPath(projectId, jobId)}/apply/plan`, { method: 'POST', body: selection })
}

export function applyToCatalog(projectId: string, jobId: string, selection: IApplySelection, planHash: string, confirm: string[]): Promise<IApplyResult> {
  return api<IApplyResult>(`${jobPath(projectId, jobId)}/apply`, { method: 'POST', body: { ...selection, planHash, ...(confirm.length ? { confirm } : {}) } })
}

/** O item bloqueia a gravação inteira (o servidor recusa com 422). */
export const blocking = (item: Pick<IApplyPlanItem, 'op'>) => item.op === 'error' || item.op === 'conflict'

export const OP_LABEL: Readonly<Record<TPlanOp, string>> = {
  create: 'criar',
  update: 'alterar',
  unchanged: 'sem mudança',
  conflict: 'conflito',
  error: 'erro',
  delete: 'apagar',
}

export const PHASE_LABEL: Readonly<Record<string, string>> = {
  project: 'projeto',
  docs: 'docs',
  resources: 'skills e commands',
  rules: 'rules',
  protocols: 'complementos',
  mcps: 'MCPs',
  agents: 'agentes (fechados)',
  links: 'vínculos',
  reach: 'alcance dos agentes',
  permissions: 'permissões do projeto',
}

/** O que a falha do gravar pede da tela. */
export type TApplyFailure =
  | { type: 'plan-changed'; message: string }
  | { type: 'widening'; widenings: IWideningRef[] }
  | { type: 'forbidden'; message: string }
  | { type: 'blocked'; message: string }
  | { type: 'other'; message: string }

export function classifyApplyFailure(failure: unknown): TApplyFailure {
  if (!(failure instanceof ApiError)) return { type: 'other', message: failure instanceof Error ? failure.message : String(failure) }
  const details = (failure.details ?? {}) as { widenings?: IWideningRef[] }
  if (failure.code === 'plan_changed') return { type: 'plan-changed', message: failure.message }
  if (failure.code === 'widening_confirmation_required') return { type: 'widening', widenings: details.widenings ?? [] }
  if (failure.status === 403) return { type: 'forbidden', message: failure.message }
  if (failure.code === 'import_blocked') return { type: 'blocked', message: failure.message }
  return { type: 'other', message: failure.message }
}
