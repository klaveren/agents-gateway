import type { TSwitchFailure } from './types'

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
