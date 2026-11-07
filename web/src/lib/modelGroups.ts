import type { IFallbackStep, TSwitchFailure } from './types'

/** O valor de `modelGroup` do agente que não troca de modelo (espelha `NO_MODEL_GROUP` do servidor). */
export const NO_MODEL_GROUP = 'none'

/** ⚖️ O que troca por padrão: cota, limite e modelo indisponível. Sobrecarga costuma passar; credencial recusada é para consertar. */
export const DEFAULT_SWITCH_ON: TSwitchFailure[] = ['quota', 'rate_limit', 'model']
export const DEFAULT_COOLDOWN_MINUTES = 15

export const SWITCH_OPTIONS: Array<{ value: TSwitchFailure; label: string; hint: string }> = [
  { value: 'quota', label: 'Cota esgotada', hint: 'O plano ou o saldo da conta acabou.' },
  { value: 'rate_limit', label: 'Limite de uso', hint: 'Muitos pedidos em pouco tempo: o provedor pediu para esperar.' },
  { value: 'model', label: 'Modelo indisponível', hint: 'O modelo saiu do ar ou não existe mais nesse provedor.' },
  { value: 'overloaded', label: 'Provedor sobrecarregado', hint: 'O provedor está cheio agora; costuma passar em minutos.' },
  { value: 'auth', label: 'Credencial recusada', hint: 'A chave ou a assinatura não vale: precisa de conserto, não de troca.' },
]

/** Mesma regra do servidor: 2–48 letras minúsculas, dígitos ou hífens; `none` é reservado. */
export const MODEL_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,47}$/

/**
 * ⚖️ O passo serve? Provedor LIGADO e modelo ATIVADO no catálogo dele (a regra do servidor). `undefined` = ainda não dá para
 * saber (a lista de provedores ou o catálogo dele não chegou): nada é tirado nem marcado por palpite.
 */
export function stepServes(
  step: IFallbackStep,
  providers: ReadonlyArray<{ id: string; enabled: boolean }>,
  catalog: (providerId: string) => ReadonlyArray<{ modelId: string; enabled: boolean; available: boolean }> | undefined,
): boolean | undefined {
  const provider = providers.find((item) => item.id === step.provider)
  if (!provider) return providers.length ? false : undefined
  if (!provider.enabled) return false
  const models = catalog(step.provider)
  if (!models) return undefined
  return models.some((model) => model.modelId === step.model && model.enabled && model.available !== false)
}
