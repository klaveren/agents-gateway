import type { IAgent, IAgentTarget } from './models/Agent.Model'
import type { TProviderFailure } from './Provider.Failure'

/**
 * ⚖️ OS GRUPOS DE MODELOS: a ordem de troca quando um modelo falha por cota, limite ou erro do próprio modelo. O grupo
 * mora nas Configurações (Grupos de modelos) e o agente só aponta para um (`modelGroup`); sem apontar, vale o grupo
 * padrão. ⚖️ A conversa FICA no passo que funcionou até alguém trocar de novo: não volta ao primeiro, não alterna.
 *
 * ⚖️ O QUE O AGENTE PODE ESCOLHER NO CHAT continua sendo os modelos dele (`providers`). O grupo é o que roda quando
 * ninguém escolheu (delegação, trigger, agendamento, API) e para onde a conversa vai quando o modelo falha.
 */
export interface IFallbackStep {
  provider: string
  model: string
}

/** Um grupo de modelos: passos em ordem e as regras de troca. */
export interface IModelGroup {
  /** 2–48 letras minúsculas, dígitos ou hífens. */
  id: string
  name: string
  description?: string
  steps: IFallbackStep[]
  /** As falhas que trocam de passo. Ausente = `DEFAULT_SWITCH_ON`. */
  switchOn?: TProviderFailure[]
  /** Quanto tempo o passo que falhou fica de lado quando o erro não diz quando volta. Ausente = `DEFAULT_COOLDOWN_MINUTES`. */
  cooldownMinutes?: number
}

/** O agente que não troca: falhou, o erro sai como sempre. */
export const NO_MODEL_GROUP = 'none'

/** O que troca por padrão: cota, limite e o modelo que não está disponível. Sobrecarga costuma passar (o SDK repete); credencial errada é para consertar. */
export const DEFAULT_SWITCH_ON: readonly TProviderFailure[] = ['quota', 'rate_limit', 'model']
/** As falhas que um grupo pode escolher. */
export const SWITCHABLE_FAILURES: readonly TProviderFailure[] = ['quota', 'rate_limit', 'model', 'overloaded', 'auth']

export const MODEL_GROUP_BOUNDS = { groups: 50, steps: 10, name: 80, description: 500, cooldownMinutes: { min: 1, max: 24 * 60 } } as const
export const DEFAULT_COOLDOWN_MINUTES = 15
export const MODEL_GROUP_ID = /^[a-z0-9][a-z0-9-]{1,47}$/

/** As configurações que o grupo lê. */
export interface IModelGroupSettings {
  modelGroups?: IModelGroup[]
  defaultModelGroup?: string
}

/** O grupo do agente: o dele, senão o padrão. `none` (ou um id que sumiu) = nenhum. */
export function groupOf(agent: Pick<IAgent, 'modelGroup'>, settings: IModelGroupSettings | undefined): IModelGroup | undefined {
  const id = agent.modelGroup ?? settings?.defaultModelGroup
  if (!id || id === NO_MODEL_GROUP) return undefined
  return settings?.modelGroups?.find((group) => group.id === id)
}

/** Os passos do grupo, sem repetir. */
export function fallbackChain(group: IModelGroup | undefined): IFallbackStep[] {
  const steps = group?.steps ?? []
  return steps.filter((step, index) => steps.findIndex((other) => sameStep(other, step)) === index)
}

/** A falha troca de passo neste grupo? */
export function switchesOn(group: IModelGroup | undefined, kind: TProviderFailure | undefined): boolean {
  return !!group && !!kind && (group.switchOn ?? DEFAULT_SWITCH_ON).includes(kind)
}

/**
 * ⚖️ O AGENTE COM OS PASSOS DO GRUPO: o passo cujo provedor o agente já tem usa o alvo dele (sandbox, rede); o provedor
 * novo herda o sandbox e a rede do alvo PADRÃO do agente — o sandbox é a intenção do agente, não do provedor. Os alvos
 * entram no fim: o padrão (o primeiro) continua o do agente.
 */
export function withGroupTargets(agent: IAgent, group: IModelGroup | undefined): IAgent {
  const steps = fallbackChain(group)
  if (!steps.length) return agent
  const base = agent.providers[0]
  const providers: IAgentTarget[] = agent.providers.map((target) => ({ ...target, models: [...target.models] }))
  for (const step of steps) {
    const target = providers.find((candidate) => candidate.provider === step.provider)
    if (target) {
      if (!target.models.includes(step.model)) target.models.push(step.model)
      continue
    }
    providers.push({
      provider: step.provider,
      models: [step.model],
      ...(base?.sandbox ? { sandbox: base.sandbox } : {}),
      ...(base?.network ? { network: base.network } : {}),
    })
  }
  return { ...agent, providers }
}

/**
 * O próximo passo depois de uma falha: o primeiro da cadeia que ainda não foi tentado neste turno e que pode rodar.
 * O passo em que a conversa estava conta como tentado (está em `tried`: o passo, ou o provedor inteiro na cota).
 */
export function nextStep(chain: readonly IFallbackStep[], tried: ReadonlySet<string>, usable: (step: IFallbackStep) => boolean): IFallbackStep | undefined {
  return chain.find((step) => !tried.has(stepKey(step)) && !tried.has(step.provider) && usable(step))
}

export function stepKey(step: IFallbackStep): string {
  return `${step.provider}/${step.model}`
}

/** ⚖️ A falha de COTA (e de limite) é da conta: o provedor inteiro sai. A do MODELO é dele: os outros modelos do provedor seguem. */
export function benchKeyOf(step: IFallbackStep, kind: TProviderFailure | undefined): string {
  return kind === 'model' ? stepKey(step) : step.provider
}

function sameStep(a: IFallbackStep, b: IFallbackStep): boolean {
  return a.provider === b.provider && a.model === b.model
}

/** Os problemas dos grupos (o que a tela e a API recusam), campo a campo. `known`: os provedores configurados. */
export function modelGroupIssues(groups: readonly IModelGroup[], known?: (provider: string) => boolean): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (groups.length > MODEL_GROUP_BOUNDS.groups) issues.push({ field: 'modelGroups', message: `at most ${MODEL_GROUP_BOUNDS.groups} groups` })
  const seen = new Set<string>()
  groups.forEach((group, index) => {
    const at = `modelGroups[${index}]`
    if (!MODEL_GROUP_ID.test(group.id) || group.id === NO_MODEL_GROUP) issues.push({ field: `${at}.id`, message: '2–48 lowercase letters, digits or hyphens (not "none")' })
    else if (seen.has(group.id)) issues.push({ field: `${at}.id`, message: `duplicate id: ${group.id}` })
    seen.add(group.id)
    if (!group.name.trim() || group.name.length > MODEL_GROUP_BOUNDS.name) issues.push({ field: `${at}.name`, message: `required, up to ${MODEL_GROUP_BOUNDS.name} characters` })
    if (!group.steps.length) issues.push({ field: `${at}.steps`, message: 'at least one step' })
    if (group.steps.length > MODEL_GROUP_BOUNDS.steps) issues.push({ field: `${at}.steps`, message: `at most ${MODEL_GROUP_BOUNDS.steps} steps` })
    group.steps.forEach((step, position) => {
      if (known && !known(step.provider)) issues.push({ field: `${at}.steps[${position}].provider`, message: `unknown provider: ${step.provider}` })
    })
    for (const kind of group.switchOn ?? []) if (!SWITCHABLE_FAILURES.includes(kind)) issues.push({ field: `${at}.switchOn`, message: `unknown failure: ${kind}` })
  })
  return issues
}
