import { IAgent, IAgentTarget } from './models/Agent.Model'
import { IProviderConfig } from './models/Provider.Model'
import { isSubscription, subscriptionAdminOnly } from './Subscription.Policy'
import { dangerousToolsAdminOnly, dangerousToolsOf } from './Tool.Policy'

/** Por que um agente não pode abrir conversa AGORA — o que a tela mostra ao admin. */
export type TAgentUnavailable = 'provider_disabled' | 'no_model' | 'no_key' | 'admin_only'

export const UNAVAILABLE_LABEL: Readonly<Record<TAgentUnavailable, string>> = {
  provider_disabled: 'provider desligado ou removido',
  no_model: 'nenhum modelo ativo',
  no_key: 'provider sem chave',
  admin_only: 'só para administradores',
}

export interface IAvailabilityFacts {
  /** O provider, como está no banco. */
  provider?: IProviderConfig
  /** O provider tem a credencial que precisa (chave salva; a assinatura não exige). */
  hasKey: boolean
  /** Quem pergunta é administrador provado. */
  admin: boolean
}

/**
 * ⛔ "ATIVO" NUM LUGAR SÓ: um provider do agente roda se está ligado, há um modelo utilizável
 * (`target.models` já vem filtrado pelo catálogo: ativado E disponível) e a credencial existe — e, para
 * quem não administra, se ele não exige admin (assinatura, ferramenta que alcança o servidor).
 * `undefined` = pode.
 */
export function targetUnavailable(agent: IAgent, target: IAgentTarget, facts: IAvailabilityFacts): TAgentUnavailable | undefined {
  if (!facts.provider?.enabled) return 'provider_disabled'
  if (!target.models.length) return 'no_model'
  if (!isSubscription(facts.provider.protocol) && !facts.hasKey) return 'no_key'
  if (!facts.admin) {
    if (isSubscription(facts.provider.protocol) && subscriptionAdminOnly()) return 'admin_only'
    if (dangerousToolsOf(agent.allowedTools).length && dangerousToolsAdminOnly()) return 'admin_only'
  }
  return undefined
}

/**
 * O agente abre conversa se ALGUM provider dele roda. Senão, o motivo é o do padrão (o primeiro).
 * É a mesma regra da lista, do agente padrão, da delegação e das configurações.
 */
export function agentUnavailable(agent: IAgent, factsOf: (providerId: string) => IAvailabilityFacts): TAgentUnavailable | undefined {
  const reasons = agent.providers.map((target) => targetUnavailable(agent, target, factsOf(target.provider)))
  if (!reasons.length) return 'no_model'
  return reasons.some((reason) => !reason) ? undefined : reasons[0]
}
