import { offers } from './Agent.Policy'
import type { IAgent } from './models/Agent.Model'

/**
 * ⚖️ A TROCA DE PROVEDOR QUANDO A COTA ACABA: a conversa segue no próximo da cadeia, com a transcrição, em vez de
 * parar no erro. A cadeia é GLOBAL (Configurações → Troca de provedor) ou do AGENTE (`fallback`), e cada passo é um
 * provedor + modelo.
 *
 * ⛔ SÓ PASSO QUE O AGENTE OFERECE. A cadeia global é uma ordem de preferência, nunca um provedor a mais: um agente que
 * só roda na assinatura não passa a gastar API porque a cadeia global a tem.
 */
export interface IFallbackStep {
  provider: string
  model: string
}

export type TFallbackMode = 'global' | 'own' | 'off'
export const FALLBACK_MODES: readonly TFallbackMode[] = ['global', 'own', 'off']

/** A troca deste agente. Ausente = `global`. */
export interface IAgentFallback {
  mode: TFallbackMode
  /** A cadeia própria (só vale com `own`). */
  chain?: IFallbackStep[]
}

/** A troca global (Configurações). Cadeia vazia = desligada. */
export interface IFallbackSettings {
  chain: IFallbackStep[]
  /** Quanto tempo o provedor que estourou fica de lado quando o erro não diz quando volta. Padrão: 15. */
  cooldownMinutes?: number
}

export const FALLBACK_BOUNDS = { chain: 10, cooldownMinutes: { min: 1, max: 24 * 60 } } as const
export const DEFAULT_COOLDOWN_MINUTES = 15

/** A cadeia que vale para o agente, só com os passos que ele oferece, sem repetir. */
export function fallbackChain(agent: IAgent, global: IFallbackSettings | undefined): IFallbackStep[] {
  const mode = agent.fallback?.mode ?? 'global'
  const chain = mode === 'off' ? [] : mode === 'own' ? (agent.fallback?.chain ?? []) : (global?.chain ?? [])
  return chain.filter((step, index) => offers(agent, step.provider, step.model) && chain.findIndex((other) => sameStep(other, step)) === index)
}

/**
 * O próximo passo depois de uma falha: o primeiro da cadeia que ainda não foi tentado neste turno e que pode rodar.
 * O passo em que a conversa estava conta como tentado (está em `tried`).
 */
export function nextStep(chain: readonly IFallbackStep[], tried: ReadonlySet<string>, usable: (step: IFallbackStep) => boolean): IFallbackStep | undefined {
  return chain.find((step) => !tried.has(stepKey(step)) && !tried.has(step.provider) && usable(step))
}

export function stepKey(step: IFallbackStep): string {
  return `${step.provider}/${step.model}`
}

function sameStep(a: IFallbackStep, b: IFallbackStep): boolean {
  return a.provider === b.provider && a.model === b.model
}
