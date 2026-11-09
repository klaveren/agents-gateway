import { liveLimit, TLimitName, UNLIMITED } from './models/Limits.Model'

/**
 * ⚖️ O TETO DE USO DO MÊS: quanto o gateway inteiro e cada pessoa podem gastar, em US$ e em tokens (entrada + saída),
 * do dia 1º (UTC) até agora. Bateu, o turno seguinte é recusado com o motivo; o que já está rodando termina. Ausente
 * ou -1 = sem teto (o padrão: nada muda para quem não configurou).
 */
export interface IUsageCaps {
  monthlyCostUsd?: number
  userMonthlyCostUsd?: number
  monthlyTokens?: number
  userMonthlyTokens?: number
}

/** O consumo do mês: custo em US$ e tokens. */
export interface IUsageSpent {
  costUsd: number
  tokens: number
}

/** O teto que bateu: de quem (o gateway ou a pessoa), do quê, quanto é e quanto já foi. */
export interface ICapHit {
  scope: 'gateway' | 'user'
  kind: 'cost' | 'tokens'
  cap: number
  used: number
}

/** O valor em vigor: a tela, senão o `.env`; -1, zero ou inválido = sem teto. */
function capOf(name: TLimitName, env: string, source: NodeJS.ProcessEnv): number | undefined {
  const value = liveLimit(name) ?? Number(source[env])
  return Number.isFinite(value) && value > 0 && value !== UNLIMITED ? value : undefined
}

export function usageCaps(env: NodeJS.ProcessEnv = process.env): IUsageCaps {
  return {
    monthlyCostUsd: capOf('monthlyCostCapUsd', 'MONTHLY_COST_CAP_USD', env),
    userMonthlyCostUsd: capOf('userMonthlyCostCapUsd', 'USER_MONTHLY_COST_CAP_USD', env),
    monthlyTokens: capOf('monthlyTokenCap', 'MONTHLY_TOKEN_CAP', env),
    userMonthlyTokens: capOf('userMonthlyTokenCap', 'USER_MONTHLY_TOKEN_CAP', env),
  }
}

export function hasCaps(caps: IUsageCaps): boolean {
  return Object.values(caps).some((value) => value !== undefined)
}

/** O primeiro teto alcançado (o do gateway antes do da pessoa), ou nada. Alcançar = usado >= teto. */
export function capReached(caps: IUsageCaps, gateway: IUsageSpent, user?: IUsageSpent): ICapHit | undefined {
  const checks: Array<[ICapHit['scope'], ICapHit['kind'], number | undefined, number | undefined]> = [
    ['gateway', 'cost', caps.monthlyCostUsd, gateway.costUsd],
    ['gateway', 'tokens', caps.monthlyTokens, gateway.tokens],
    ['user', 'cost', caps.userMonthlyCostUsd, user?.costUsd],
    ['user', 'tokens', caps.userMonthlyTokens, user?.tokens],
  ]
  for (const [scope, kind, cap, used] of checks) if (cap !== undefined && used !== undefined && used >= cap) return { scope, kind, cap, used }
  return undefined
}

/** O começo do mês, em UTC: de onde o teto conta. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** A recusa, em português (a tela mostra como veio). */
export function capMessage(hit: ICapHit): string {
  const who = hit.scope === 'gateway' ? 'O gateway' : 'Você'
  const amount = hit.kind === 'cost' ? `US$ ${hit.cap.toLocaleString('pt-BR')}` : `${hit.cap.toLocaleString('pt-BR')} tokens`
  return `${who} atingiu o teto de uso do mês (${amount}). Novas mensagens voltam no dia 1º, ou quando quem administra aumentar o teto em Configuração → Limites.`
}
