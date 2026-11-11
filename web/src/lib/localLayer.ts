import type { IPermissionRule, TSandboxLevel } from './types'

/** A marca da ferramenta automática desligada (`off:<ferramenta>`), como no servidor. */
export const AUTO_TOOL_OFF = 'off:'
/** ⚖️ As automáticas (ver `Auto.Tools` no servidor): ligadas sem estar no `allowedTools`. */
export const AUTO_TOOLS: readonly string[] = ['ledger_read', 'ledger_write', 'conversation_panel', 'deliver_file', 'read_doc', 'search_docs', 'use_resource', 'search_resources']

export interface ILocalProvider {
  provider: string
  models: string[]
  sandbox?: TSandboxLevel
  network?: boolean
}

/** O que a camada local guarda: os modelos desta máquina (substituem), e as ferramentas e regras a mais (somam). */
export interface IAgentLocalLayerInput {
  providers?: ILocalProvider[]
  allowedTools: string[]
  permissions: IPermissionRule[]
}

/** 🔌 A camada local de um agente de projeto conectado: a origem (travada) e o que esta máquina acrescentou. */
export interface IAgentLocalLayerView {
  agentId: string
  projectId: string
  origin: { providers: ILocalProvider[]; allowedTools: string[]; permissions: IPermissionRule[] }
  layer: IAgentLocalLayerInput
  updatedAt?: string
  updatedBy?: string
}

const offMark = (tool: string) => `${AUTO_TOOL_OFF}${tool}`

/**
 * O `allowedTools` que o formulário mostra: o da origem com o da camada por cima. A automática que a origem desligou
 * e a camada religou perde a marca `off:` (aparece ligada).
 */
export function shownTools(origin: readonly string[], layer: readonly string[]): string[] {
  const back = new Set(layer.filter((tool) => AUTO_TOOLS.includes(tool)).map(offMark))
  const kept = origin.filter((tool) => !back.has(tool))
  return [...kept, ...layer.filter((tool) => !AUTO_TOOLS.includes(tool) && !tool.startsWith(AUTO_TOOL_OFF) && !kept.includes(tool))]
}

/**
 * O caminho de volta: o que o formulário tem A MAIS que a origem é o que a camada grava. A marca `off:` da origem que
 * saiu do formulário vira o pedido de religar (o nome da automática).
 */
export function layerTools(origin: readonly string[], form: readonly string[]): string[] {
  const extras = form.filter((tool) => !tool.startsWith(AUTO_TOOL_OFF) && !AUTO_TOOLS.includes(tool) && !origin.includes(tool))
  const back = origin.filter((tool) => tool.startsWith(AUTO_TOOL_OFF) && !form.includes(tool)).map((tool) => tool.slice(AUTO_TOOL_OFF.length))
  return [...new Set([...extras, ...back.filter((tool) => AUTO_TOOLS.includes(tool))])]
}

/**
 * ⛔ O que veio da origem não muda aqui: a entrada que ela tem fica travada. A automática é travada LIGADA (a camada
 * não desliga nada); só a que a origem desligou pode ser religada.
 */
export function originLocksTool(origin: readonly string[], tool: string): boolean {
  return AUTO_TOOLS.includes(tool) ? !origin.includes(offMark(tool)) : origin.includes(tool)
}
