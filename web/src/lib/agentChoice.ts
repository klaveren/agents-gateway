import type { IAgent, IAgentProvider } from './types'

/** Um provider + modelo do agente: o que a conversa escolhe, e o que troca no meio dela. */
export interface IChoice {
  provider: string
  model: string
}

/**
 * O valor de um `<select>` que escolhe provider e modelo juntos. ⚖️ `|`, e não `/`: id de modelo de
 * compatível tem barra (`anthropic/claude-…` no OpenRouter). É a mesma chave do uso no servidor.
 */
export function choiceKey(choice: IChoice): string {
  return `${choice.provider}|${choice.model}`
}

export function parseChoice(key: string): IChoice | undefined {
  const at = key.indexOf('|')
  return at < 0 ? undefined : { provider: key.slice(0, at), model: key.slice(at + 1) }
}

/** O provider do agente com este id. */
export function providerOf(agent: Pick<IAgent, 'providers'>, providerId: string | undefined): IAgentProvider | undefined {
  return providerId ? agent.providers.find((provider) => provider.id === providerId) : undefined
}

/** O agente oferece este modelo neste provider. */
export function offers(agent: Pick<IAgent, 'providers'>, choice: Partial<IChoice>): boolean {
  return !!choice.model && !!providerOf(agent, choice.provider)?.models.includes(choice.model)
}

/**
 * O provider e o modelo que valem: o pedido, se o agente o oferece; só o modelo, no primeiro provider que
 * o oferece; senão o padrão — o primeiro modelo do primeiro provider que roda (sem `unavailable`).
 */
export function resolveChoice(agent: Pick<IAgent, 'providers'>, wanted: Partial<IChoice> = {}): IChoice | undefined {
  if (offers(agent, wanted)) return { provider: wanted.provider!, model: wanted.model! }
  if (!wanted.provider && wanted.model) {
    const offering = agent.providers.find((provider) => !provider.unavailable && provider.models.includes(wanted.model!))
    if (offering) return { provider: offering.id, model: wanted.model }
  }
  const fallback = agent.providers.find((provider) => !provider.unavailable && provider.models.length) ?? agent.providers.find((provider) => provider.models.length)
  return fallback ? { provider: fallback.id, model: fallback.models[0] } : undefined
}

/** Os níveis que AQUELE modelo aceita naquele provider; `[]` = não raciocina (sem seletor). */
export function levelsOf(agent: Pick<IAgent, 'providers' | 'reasoningEfforts'>, choice: Partial<IChoice> | undefined): string[] {
  const provider = providerOf(agent, choice?.provider)
  if (!provider) return []
  return (choice?.model ? provider.modelReasoning?.[choice.model] : undefined) ?? provider.reasoningEfforts ?? []
}
