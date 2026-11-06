import type { IPermissionRule } from '@domain/Permission.Policy'

/** `expired` não é gravado: sai da leitura (pendente há mais de `PERMISSION_REQUEST_TTL_DAYS`). */
export type TPermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'
export type TStoredPermissionRequestStatus = Exclude<TPermissionRequestStatus, 'expired'>

/** Uma ampliação a confirmar: a chave estável (a do `Catalog.Widening`) e o texto para quem confirma. */
export interface IPermissionWidening {
  key: string
  description: string
}

/**
 * Quem pediu. ⚠️ `agentId` e `conversationId` são RÓTULO (os cabeçalhos de identidade que o gateway manda ao próprio
 * MCP), nunca credencial: servem para a pessoa saber de onde veio o pedido. Quem pode pedir é decidido pela conta (`by`).
 */
export interface IPermissionRequester {
  by: string
  agentId?: string
  conversationId?: string
}

/**
 * O que o pedido muda: as regras de um agente, as regras de um projeto (a camada de baixo), ou campos de um agente
 * (`patch_agent`: ferramentas, delegação, exposição, sandbox…).
 */
export type TPermissionRequestKind = 'agent-rules' | 'project-rules' | 'agent-patch' | 'secret'
export const PERMISSION_REQUEST_KINDS: readonly TPermissionRequestKind[] = ['agent-rules', 'project-rules', 'agent-patch', 'secret']

/**
 * `secret`: o agente pediu uma VARIÁVEL SECRETA (ver `ResourceSecret.Model`) pelo nome — a pessoa digita o valor na tela, ao
 * aprovar. O pedido guarda só o alvo e o nome (em `secret`), nunca valor.
 */
export interface IPermissionRequestSecret {
  scope: 'agent' | 'skill' | 'command'
  scopeId: string
  name: string
  description?: string
  /** Skill ou command compartilhado: o projeto que RECEBEU e cujos valores o pedido preenche. Ausente = a origem. */
  project?: string
}

/**
 * UM PEDIDO DE PERMISSÃO: as ampliações que um agente pediu — para as regras de um agente (o dele ou outro), as de um
 * projeto, ou campos de um agente —, guardadas até um administrador confirmar NA TELA. ⛔ Nada dele vale antes disso.
 */
export interface IPermissionRequest {
  id: string
  kind: TPermissionRequestKind
  /** O agente que muda (`agent-rules`, `agent-patch`). */
  agentId?: string
  /** O projeto: o que muda (`project-rules`) ou o do agente quando o pedido foi feito (ausente = global). */
  projectId?: string
  /** As regras a acrescentar (`allow`) e a tirar (`deny`): só o que amplia — o que restringe já foi aplicado. */
  add: IPermissionRule[]
  remove: IPermissionRule[]
  /** `agent-patch`: os campos do agente com o valor pedido (`null` = tirar). Só os que ampliam. */
  patch?: Record<string, unknown>
  /** `agent-patch` de um campo-lista: as entradas a ACRESCENTAR ao valor de agora (uma por pedido; ver `splitAgentPatchItems`). */
  entries?: { field: string; add: string[] }
  /**
   * ⚖️ UM PEDIDO É UM ITEM (uma regra, um campo, uma entrada de lista): a pessoa aprova ou recusa cada um. Os itens que
   * saíram da MESMA chamada do agente dividem o `batchId` (a tela agrupa; o motivo é o mesmo). Ausente: um item só.
   */
  batchId?: string
  /** `secret`: a variável pedida (o valor entra só na aprovação, pela tela). */
  secret?: IPermissionRequestSecret
  /** As ampliações calculadas no pedido (a auditoria). A tela confirma as recalculadas sobre o agente de agora. */
  widenings: IPermissionWidening[]
  reason: string
  requestedBy: IPermissionRequester
  /** O alvo quando o pedido foi feito (a impressão das regras, ou do agente no `agent-patch`): outra na leitura = mudou no meio. */
  baseHash: string
  createdAt: Date
  status: TStoredPermissionRequestStatus
  decidedBy?: string
  decidedAt?: Date
  decisionNote?: string
}

/** Pedido pendente por mais que isto vence: não é mais aprovado (pede-se de novo). */
export const PERMISSION_REQUEST_TTL_DAYS = 7
export const PERMISSION_REQUEST_LIMITS = { rules: 50, reason: 1000, note: 500 } as const
