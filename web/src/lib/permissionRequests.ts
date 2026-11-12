import type { IWideningRef } from '@/lib/catalogHistory'
import type { IPermissionRule } from '@/lib/types'

export type TPermissionRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired'

/**
 * Um pedido de permissão de um agente (o servidor recalcula `widenings` sobre o agente de agora). ⛔ Só um administrador
 * na tela aprova: o `confirm` são EXATAMENTE as chaves de `widenings`.
 */
export type TPermissionRequestKind = 'agent-rules' | 'project-rules' | 'agent-patch' | 'agent-local' | 'secret'

export interface IPermissionRequest {
  id: string
  /**
   * O que muda: as regras de um agente, as de um projeto, campos de um agente (`patch_agent`), uma variável secreta, ou
   * (🔌 `agent-local`) uma ferramenta, um MCP ou uma delegação ligada SÓ NESTA MÁQUINA num agente de projeto conectado.
   */
  kind: TPermissionRequestKind
  agentId?: string
  agentName?: string
  projectId?: string
  projectName?: string
  add: IPermissionRule[]
  remove: IPermissionRule[]
  /** `agent-patch`: os campos pedidos, com o valor (`null` = tirar). */
  patch?: Record<string, unknown>
  /** `agent-patch` de um campo-lista: a entrada a ACRESCENTAR ao valor de agora (`allowedTools` + `agent:ana`). `agent-local`: a entrada a ligar aqui. */
  entries?: { field: string; add: string[] }
  /** `secret.project`: skill/command compartilhado — o projeto que recebe e cujo valor o pedido preenche (ausente = a origem). */
  /** `secret`: a variável pedida (só o nome — ⛔ o valor é digitado por quem aprova, nunca vem no pedido). */
  secret?: { scope: 'agent' | 'skill' | 'command'; scopeId: string; name: string; description?: string; project?: string }
  widenings: IWideningRef[]
  requestedWidenings: IWideningRef[]
  /** As regras do agente mudaram desde o pedido: `widenings` foi recalculado. */
  changed: boolean
  reason: string
  /** Os pedidos da mesma chamada do agente dividem o lote (cada pedido leva um item só); sem ele, o pedido é sozinho. */
  batchId?: string
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

/** "allowedTools + agent:ana" — a entrada de lista que o pedido acrescenta. */
export function entriesLine(entries: { field: string; add: string[] }): string {
  return `${entries.field} + ${entries.add.join(', ')}`
}

/** "Ligar só nesta máquina: agent:ana" — a entrada que o pedido `agent-local` liga na camada local do agente. */
export function localLine(entries: { field: string; add: string[] }): string {
  return `Ligar só nesta máquina: ${entries.add.join(', ')}`
}

/** A linha da entrada de lista de um pedido: a do `agent-local` diz que é só daqui. */
export const requestEntriesLine = (request: Pick<IPermissionRequest, 'kind'>, entries: { field: string; add: string[] }): string =>
  request.kind === 'agent-local' ? localLine(entries) : entriesLine(entries)

const entryKind = (entry: string | undefined) => (entry?.startsWith('agent:') ? 'Delegação' : entry?.startsWith('mcp:') ? 'MCP' : 'Ferramenta')

/** O tipo do pedido, em uma palavra: "Regra", "Delegação", "MCP", "Ferramenta", "Campo do agente", "Variável secreta". */
export function kindLabel(request: IPermissionRequest): string {
  if (request.kind === 'secret') return 'Variável secreta'
  if (request.entries) return entryKind(request.entries.add[0])
  return request.kind === 'agent-patch' ? 'Campo do agente' : 'Regra'
}

/**
 * O pedido numa linha, para a lista do "Aprovar todos": o que ele abre AGORA (as ampliações que o servidor recalculou);
 * sem ampliação, o que ele troca. O `agent-local` diz que é só desta máquina.
 */
export function itemSummary(request: IPermissionRequest): string {
  const here = request.kind === 'agent-local' ? ' — só nesta máquina' : ''
  if (request.widenings.length) return `${request.widenings.map((item) => item.description).join('; ')}${here}`
  if (request.secret) return secretLine(request.secret)
  if (request.entries) return requestEntriesLine(request, request.entries)
  const patch = Object.entries(request.patch ?? {}).map(([field, value]) => patchLine(field, value))
  return [...request.add.map((rule) => ruleLine(rule, 'add')), ...request.remove.map((rule) => ruleLine(rule, 'remove')), ...patch].join('; ')
}

/**
 * De quem é o pedido: o agente, o projeto (as regras dele) ou a skill/command da variável. É por ele que a tela de
 * Notificações separa as listas. ⚠️ No pedido `secret` de skill ou command, `agentId` é quem PEDIU, não o alvo.
 */
export function targetKey(request: IPermissionRequest): string {
  if (request.kind === 'secret' && request.secret) return `${request.secret.scope}:${request.secret.scopeId}`
  if (request.kind === 'project-rules') return `project:${request.projectId ?? ''}`
  return `agent:${request.agentId ?? ''}`
}

/** "Agente Theo", "Projeto Alfa", "Skill gitlab" — o título da lista de um alvo. */
export function targetTitle(request: IPermissionRequest): string {
  if (request.kind === 'secret' && request.secret && request.secret.scope !== 'agent') return `${request.secret.scope === 'skill' ? 'Skill' : 'Command'} ${request.secret.scopeId}`
  if (request.kind === 'project-rules') return `Projeto ${request.projectName ?? request.projectId ?? ''}`
  return `Agente ${request.agentName ?? request.agentId ?? request.secret?.scopeId ?? ''}`
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

const SECRET_SCOPE: Record<NonNullable<IPermissionRequest['secret']>['scope'], string> = { agent: 'agente', skill: 'skill', command: 'command' }

/** "Variável secreta pedida: GITLAB_TOKEN para skill gitlab" — o título do pedido `secret`. */
export function secretLine(secret: NonNullable<IPermissionRequest['secret']>): string {
  return `Variável secreta pedida: ${secret.name} para ${SECRET_SCOPE[secret.scope] ?? secret.scope} ${secret.scopeId}`
}

/** "valor do projeto Beta" — só quando o pedido é de um projeto que RECEBE o compartilhamento (`secret.project`). */
export function secretProjectLine(secret: NonNullable<IPermissionRequest['secret']>, nameOf: (id: string) => string | undefined): string | undefined {
  return secret.project ? `valor do projeto ${nameOf(secret.project) ?? secret.project}` : undefined
}
