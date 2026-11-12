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

/**
 * O que a camada local guarda: os modelos desta máquina (substituem), as ferramentas e regras a mais (somam) e o que
 * veio da origem e não vale aqui (`disabledTools`: a entrada de lá, ou o nome da automática).
 */
export interface IAgentLocalLayerInput {
  providers?: ILocalProvider[]
  allowedTools: string[]
  disabledTools?: string[]
  permissions: IPermissionRule[]
}

/** 🔌 A camada local de um agente de projeto conectado: a origem e o que esta máquina acrescentou ou desligou. */
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
 * e a camada religou perde a marca `off:` (aparece ligada); o que a camada desligou sai (a automática ganha a marca).
 */
export function shownTools(origin: readonly string[], layer: readonly string[], disabled: readonly string[] = []): string[] {
  const back = new Set(layer.filter((tool) => AUTO_TOOLS.includes(tool)).map(offMark))
  const kept = origin.filter((tool) => !back.has(tool) && !disabled.includes(tool))
  const extras = layer.filter((tool) => !AUTO_TOOLS.includes(tool) && !tool.startsWith(AUTO_TOOL_OFF) && !kept.includes(tool))
  const off = disabled.filter((tool) => AUTO_TOOLS.includes(tool) && !back.has(offMark(tool))).map(offMark)
  return [...new Set([...kept, ...extras, ...off])]
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
 * O que a origem tem e o formulário não: é o que esta máquina desligou. A entrada de lá vai como está; a automática
 * que ganhou a marca `off:` aqui vai pelo nome.
 */
export function disabledTools(origin: readonly string[], form: readonly string[]): string[] {
  const gone = origin.filter((tool) => !tool.startsWith(AUTO_TOOL_OFF) && !form.includes(tool))
  const off = form.filter((tool) => tool.startsWith(AUTO_TOOL_OFF) && !origin.includes(tool)).map((tool) => tool.slice(AUTO_TOOL_OFF.length))
  return [...new Set([...gone, ...off.filter((tool) => AUTO_TOOLS.includes(tool))])]
}

/** A ferramenta veio LIGADA da origem? (A entrada que ela tem; a automática, se ela não a desligou.) */
export function originHasTool(origin: readonly string[], tool: string): boolean {
  return AUTO_TOOLS.includes(tool) ? !origin.includes(offMark(tool)) : origin.includes(tool)
}
