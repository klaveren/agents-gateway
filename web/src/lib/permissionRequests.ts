import type { IWideningRef } from '@/lib/catalogHistory'
import type { IPermissionRule } from '@/lib/types'

export type TPermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * Um pedido de permissão de um agente (o servidor recalcula `widenings` sobre o agente de agora). ⛔ Só um administrador
 * na tela aprova: o `confirm` são EXATAMENTE as chaves de `widenings`.
 */
export type TPermissionRequestKind = 'agent-rules' | 'project-rules' | 'agent-patch'

export interface IPermissionRequest {
  id: string
  /** O que muda: as regras de um agente, as de um projeto, ou campos de um agente (`patch_agent`). */
  kind: TPermissionRequestKind
  agentId?: string
  agentName?: string
  projectId?: string
  projectName?: string
  add: IPermissionRule[]
  remove: IPermissionRule[]
  /** `agent-patch`: os campos pedidos, com o valor (`null` = tirar). */
  patch?: Record<string, unknown>
  widenings: IWideningRef[]
  requestedWidenings: IWideningRef[]
  /** As regras do agente mudaram desde o pedido: `widenings` foi recalculado. */
  changed: boolean
  reason: string
  /** `agentId` e `conversationId` são rótulo (de onde veio), não credencial. */
  requestedBy: { by: string; agentId?: string; conversationId?: string }
  createdAt: string
  expiresAt: string
  status: TPermissionRequestStatus
  decidedBy?: string
  decidedAt?: string
  decisionNote?: string
}

const CATEGORY: Record<IPermissionRule['category'], string> = {
  terminal: 'terminal',
  read: 'leitura',
  write: 'escrita',
  network: 'rede',
  mcp: 'MCP',
  skill: 'skill',
  delegate: 'delegação',
  account: 'conta',
  repository: 'repositório',
  trigger: 'trigger',
}

/** "Acrescentar: permitir terminal `npm test`" — a regra como a pessoa lê. */
export function ruleLine(rule: IPermissionRule, op: 'add' | 'remove'): string {
  return `${op === 'add' ? 'Acrescentar' : 'Tirar'}: ${rule.decision === 'allow' ? 'permitir' : 'negar'} ${CATEGORY[rule.category] ?? rule.category} "${rule.pattern}"`
}

/** "allowedTools → ["read_doc","cap:terminal"]" — o campo do patch como a pessoa lê. */
export function patchLine(field: string, value: unknown): string {
  return value === null ? `${field}: tirar` : `${field} → ${JSON.stringify(value)}`
}

/** A chave da store: os de um agente, os das regras de um projeto, ou todos (`''`). */
export const requestsKey = (target: { agentId?: string; projectId?: string }): string =>
  target.agentId ? `agent:${target.agentId}` : target.projectId ? `project:${target.projectId}` : ''

/** Os pendentes (não vencidos) de um agente, ou das regras de um projeto: o número do selo. */
export function pendingCount(requests: readonly IPermissionRequest[] | undefined, target: { agentId?: string; projectId?: string }): number {
  return (requests ?? []).filter(
    (request) => request.status === 'pending' && (target.agentId ? request.agentId === target.agentId : request.kind === 'project-rules' && request.projectId === target.projectId),
  ).length
}
