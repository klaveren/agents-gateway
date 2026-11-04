import type { TSwitchFailure } from './types'

/** O valor de `modelGroup` do agente que não troca de modelo (espelha `NO_MODEL_GROUP` do servidor). */
export const NO_MODEL_GROUP = 'none'

/** ⚖️ O que troca por padrão: cota, limite e modelo indisponível. Sobrecarga costuma passar; credencial recusada é para consertar. */
export const DEFAULT_SWITCH_ON: TSwitchFailure[] = ['quota', 'rate_limit', 'model']
export const DEFAULT_COOLDOWN_MINUTES = 15

export const SWITCH_OPTIONS: Array<{ value: TSwitchFailure; label: string }> = [
  { value: 'quota', label: 'Cota esgotada' },
  { value: 'rate_limit', label: 'Limite de uso' },
  { value: 'model', label: 'Modelo indisponível' },
  { value: 'overloaded', label: 'Provedor sobrecarregado' },
  { value: 'auth', label: 'Credencial recusada' },
]

/** Mesma regra do servidor: 2–48 letras minúsculas, dígitos ou hífens; `none` é reservado. */
export const MODEL_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,47}$/
