import { IAgent } from './models/Agent.Model'
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
  /** O provider do agente, como está no banco. */
  provider?: IProviderConfig
  /** O provider tem a credencial que precisa (chave salva; a assinatura não exige). */
  hasKey: boolean
  /** Quem pergunta é administrador provado. */
  admin: boolean
}

/**
 * ⛔ "ATIVO" NUM LUGAR SÓ: o agente abre conversa se o provider está ligado, há um modelo utilizável
 * (`agent.models` já vem filtrado pelo catálogo: ativado E disponível) e a credencial existe — e, para
 * quem não administra, se ele não exige admin (assinatura, ferramenta que alcança o servidor).
 * `undefined` = pode. É a mesma regra da lista, do agente padrão, da delegação e das configurações.
 */
export function agentUnavailable(agent: IAgent, facts: IAvailabilityFacts): TAgentUnavailable | undefined {
  if (!facts.provider?.enabled) return 'provider_disabled'
  if (!agent.models.length) return 'no_model'
  if (!isSubscription(facts.provider.protocol) && !facts.hasKey) return 'no_key'
  if (!facts.admin) {
    if (isSubscription(facts.provider.protocol) && subscriptionAdminOnly()) return 'admin_only'
    if (dangerousToolsOf(agent.allowedTools).length && dangerousToolsAdminOnly()) return 'admin_only'
  }
  return undefined
}
