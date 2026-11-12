import { AUTO_TOOL_OFF, AUTO_TOOLS, isAutoToolOff } from '../Auto.Tools'
import type { IPermissionRule } from '../Permission.Policy'
import type { IAgent, IAgentTarget } from './Agent.Model'

/**
 * 🔌 A CAMADA LOCAL de um agente de projeto conectado: o que ESTA máquina acrescenta ao que veio da origem, e o que
 * ela desliga do que veio (a ferramenta, o MCP ou a delegação que não faz sentido neste ambiente).
 * ⚖️ Fica fora do catálogo: a atualização nunca a lê nem a apaga, e ela nunca é exportada nem viaja para a origem.
 */
export interface IAgentLocalLayer {
  agentId: string
  /** Os modelos desta máquina. Presentes, SUBSTITUEM os da origem (os de lá podem nem existir aqui). */
  providers?: IAgentTarget[]
  /** Ferramentas, MCPs e delegações a mais. SOMAM aos da origem. */
  allowedTools: string[]
  /**
   * O que veio da origem e NÃO vale aqui: a entrada como está na lista de lá (`run_bash`, `cap:…`, `agent:x`,
   * `mcp:srv/*`) ou o nome de uma ferramenta automática. A atualização não religa.
   */
  disabledTools?: string[]
  /** Regras a mais. SOMAM às da origem: na mesma camada, a negação de lá continua vencendo. */
  permissions: IPermissionRule[]
  updatedAt: Date
  updatedBy: string
}

export type TAgentLocalLayerInput = Pick<IAgentLocalLayer, 'providers' | 'allowedTools' | 'disabledTools' | 'permissions'>

/** A camada não muda nada? (Sem modelos próprios, sem ferramenta a mais ou desligada e sem regra.) */
export const isEmptyLayer = (layer: TAgentLocalLayerInput): boolean =>
  !layer.providers?.length && !layer.allowedTools.length && !layer.disabledTools?.length && !layer.permissions.length

/**
 * O agente como ele RODA aqui: a origem com a camada por cima.
 * ⚖️ Da origem só sai o que a camada desliga pelo nome (`disabledTools`); a ferramenta automática desligada aqui ganha
 * a marca `off:<ferramenta>`, e a que a origem desligou volta a valer quando a camada a pede pelo nome.
 * ⛔ As regras de permissão da origem nunca saem: a negação de lá continua valendo.
 */
export function mergeLocalLayer(agent: IAgent, layer: TAgentLocalLayerInput): IAgent {
  const back = new Set(layer.allowedTools.filter((tool) => AUTO_TOOLS.includes(tool)).map((tool) => `${AUTO_TOOL_OFF}${tool}`))
  const disabled = new Set(layer.disabledTools ?? [])
  const origin = agent.allowedTools.filter((tool) => !back.has(tool) && !disabled.has(tool))
  const off = [...disabled].filter((tool) => AUTO_TOOLS.includes(tool) && !back.has(`${AUTO_TOOL_OFF}${tool}`)).map((tool) => `${AUTO_TOOL_OFF}${tool}`)
  const extra = layer.allowedTools.filter((tool) => !AUTO_TOOLS.includes(tool) && !isAutoToolOff(tool) && !origin.includes(tool))
  const permissions = [...(agent.permissions ?? []), ...layer.permissions]
  return {
    ...agent,
    providers: layer.providers?.length ? layer.providers : agent.providers,
    allowedTools: [...new Set([...origin, ...extra, ...off])],
    ...(permissions.length ? { permissions } : {}),
  }
}

/**
 * A camada sem o que a origem já tem: o que sobra é o que esta máquina acrescenta de fato.
 * Uma ferramenta automática só fica se a origem a desligou (é o pedido de religar). No que se desliga, o contrário: só
 * o que a origem TEM (a entrada dela, ou a automática que ela deixou ligada).
 */
export function trimLocalLayer(agent: IAgent, layer: TAgentLocalLayerInput): TAgentLocalLayerInput {
  const allowedTools = [...new Set(layer.allowedTools)].filter((tool) =>
    AUTO_TOOLS.includes(tool) ? agent.allowedTools.includes(`${AUTO_TOOL_OFF}${tool}`) : !isAutoToolOff(tool) && !agent.allowedTools.includes(tool),
  )
  const same = (a: IPermissionRule, b: IPermissionRule) => a.category === b.category && a.pattern === b.pattern && a.decision === b.decision
  const permissions = layer.permissions.filter((rule) => !(agent.permissions ?? []).some((origin) => same(origin, rule)))
  const disabledTools = [...new Set(layer.disabledTools ?? [])].filter((tool) =>
    AUTO_TOOLS.includes(tool) ? !agent.allowedTools.includes(`${AUTO_TOOL_OFF}${tool}`) : !isAutoToolOff(tool) && agent.allowedTools.includes(tool),
  )
  return { ...(layer.providers?.length ? { providers: layer.providers } : {}), allowedTools, ...(disabledTools.length ? { disabledTools } : {}), permissions }
}
