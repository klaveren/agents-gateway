import { AUTO_TOOL_OFF, AUTO_TOOLS, isAutoToolOff } from '../Auto.Tools'
import type { IPermissionRule } from '../Permission.Policy'
import type { IAgent, IAgentTarget } from './Agent.Model'

/**
 * 🔌 A CAMADA LOCAL de um agente de projeto conectado: o que ESTA máquina acrescenta ao que veio da origem.
 * ⚖️ Fica fora do catálogo: a atualização nunca a lê nem a apaga, e ela nunca é exportada nem viaja para a origem.
 */
export interface IAgentLocalLayer {
  agentId: string
  /** Os modelos desta máquina. Presentes, SUBSTITUEM os da origem (os de lá podem nem existir aqui). */
  providers?: IAgentTarget[]
  /** Ferramentas, MCPs e delegações a mais. SOMAM aos da origem. */
  allowedTools: string[]
  /** Regras a mais. SOMAM às da origem: na mesma camada, a negação de lá continua vencendo. */
  permissions: IPermissionRule[]
  updatedAt: Date
  updatedBy: string
}

export type TAgentLocalLayerInput = Pick<IAgentLocalLayer, 'providers' | 'allowedTools' | 'permissions'>

/** A camada não muda nada? (Sem modelos próprios, sem ferramenta e sem regra.) */
export const isEmptyLayer = (layer: TAgentLocalLayerInput): boolean => !layer.providers?.length && !layer.allowedTools.length && !layer.permissions.length

/**
 * O agente como ele RODA aqui: a origem com a camada por cima.
 * ⛔ A camada só acrescenta: nada da origem sai da lista. A exceção é a marca `off:<ferramenta>`: a ferramenta
 * automática que a origem desligou volta a valer quando a camada a pede pelo nome.
 */
export function mergeLocalLayer(agent: IAgent, layer: TAgentLocalLayerInput): IAgent {
  const back = new Set(layer.allowedTools.filter((tool) => AUTO_TOOLS.includes(tool)).map((tool) => `${AUTO_TOOL_OFF}${tool}`))
  const origin = agent.allowedTools.filter((tool) => !back.has(tool))
  const extra = layer.allowedTools.filter((tool) => !AUTO_TOOLS.includes(tool) && !isAutoToolOff(tool) && !origin.includes(tool))
  const permissions = [...(agent.permissions ?? []), ...layer.permissions]
  return {
    ...agent,
    providers: layer.providers?.length ? layer.providers : agent.providers,
    allowedTools: [...origin, ...new Set(extra)],
    ...(permissions.length ? { permissions } : {}),
  }
}

/**
 * A camada sem o que a origem já tem: o que sobra é o que esta máquina acrescenta de fato.
 * Uma ferramenta automática só fica se a origem a desligou (é o pedido de religar).
 */
export function trimLocalLayer(agent: IAgent, layer: TAgentLocalLayerInput): TAgentLocalLayerInput {
  const allowedTools = [...new Set(layer.allowedTools)].filter((tool) =>
    AUTO_TOOLS.includes(tool) ? agent.allowedTools.includes(`${AUTO_TOOL_OFF}${tool}`) : !isAutoToolOff(tool) && !agent.allowedTools.includes(tool),
  )
  const same = (a: IPermissionRule, b: IPermissionRule) => a.category === b.category && a.pattern === b.pattern && a.decision === b.decision
  const permissions = layer.permissions.filter((rule) => !(agent.permissions ?? []).some((origin) => same(origin, rule)))
  return { ...(layer.providers?.length ? { providers: layer.providers } : {}), allowedTools, permissions }
}
