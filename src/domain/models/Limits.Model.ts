/**
 * Os limites que a operação ajusta sem deploy: tetos de custo e de carga por turno e por conta.
 *
 * ⚖️ O `.env` É SÓ O VALOR INICIAL. O que está nas configurações (`settings.limits`) vence, e é lido
 * a cada chamada: baixar o teto de turnos porque um agente entrou em loop não pode esperar um restart.
 *
 * ⛔ OS LIMITES TÊM FAIXA. Um teto de 0 turnos de ferramenta, ou de um milhão de tokens de saída, não é
 * ajuste, é desligar ou abrir a torneira; a faixa recusa os dois (ver `LIMIT_BOUNDS`).
 */
export type TLimitName =
  | 'maxToolTurns'
  | 'maxOutputTokens'
  | 'delegationMaxDepth'
  | 'bashTimeoutMs'
  | 'bashMaxOutputChars'
  | 'sessionsPerOwner'
  | 'streamsPerOwner'
  | 'compactAtPercent'
  | 'loopRefuseAt'
  | 'loopStopAt'
  | 'loopMaxErrors'
  | 'monthlyCostCapUsd'
  | 'userMonthlyCostCapUsd'
  | 'monthlyTokenCap'
  | 'userMonthlyTokenCap'

export type ILimits = Partial<Record<TLimitName, number>>

/**
 * "Sem teto" (-1), só no limite que o aceita (`unlimited`): os passos de ferramenta, porque um agente pode trabalhar
 * horas. O que segura o turno aí é o detector de laço (`loop*`) e o botão parar.
 */
export const UNLIMITED = -1

export const LIMIT_BOUNDS: Readonly<Record<TLimitName, { min: number; max: number; env: string; unlimited?: true }>> = {
  maxToolTurns: { min: 1, max: 200, env: 'MAX_TOOL_TURNS', unlimited: true },
  maxOutputTokens: { min: 256, max: 128_000, env: 'MAX_OUTPUT_TOKENS' },
  delegationMaxDepth: { min: 0, max: 5, env: 'DELEGATION_MAX_DEPTH' },
  bashTimeoutMs: { min: 1_000, max: 600_000, env: 'BASH_TIMEOUT_MS' },
  bashMaxOutputChars: { min: 500, max: 200_000, env: 'BASH_MAX_OUTPUT_CHARS' },
  sessionsPerOwner: { min: 1, max: 1_000, env: 'SESSIONS_PER_OWNER' },
  streamsPerOwner: { min: 1, max: 500, env: 'STREAMS_PER_OWNER' },
  compactAtPercent: { min: 50, max: 95, env: 'COMPACT_AT_PERCENT' },
  loopRefuseAt: { min: 2, max: 50, env: 'LOOP_REFUSE_AT' },
  loopStopAt: { min: 3, max: 100, env: 'LOOP_STOP_AT' },
  loopMaxErrors: { min: 3, max: 100, env: 'LOOP_MAX_ERRORS' },
  // O teto de uso do mês (ver `Usage.Cap`): do gateway inteiro e de cada pessoa, em US$ e em tokens. Ausente ou -1 = sem teto.
  monthlyCostCapUsd: { min: 1, max: 1_000_000, env: 'MONTHLY_COST_CAP_USD', unlimited: true },
  userMonthlyCostCapUsd: { min: 1, max: 1_000_000, env: 'USER_MONTHLY_COST_CAP_USD', unlimited: true },
  monthlyTokenCap: { min: 1_000, max: 100_000_000_000, env: 'MONTHLY_TOKEN_CAP', unlimited: true },
  userMonthlyTokenCap: { min: 1_000, max: 100_000_000_000, env: 'USER_MONTHLY_TOKEN_CAP', unlimited: true },
}

export const LIMIT_NAMES = Object.keys(LIMIT_BOUNDS) as TLimitName[]

/** Inteiro na faixa do limite, ou -1 no que aceita "sem teto". */
export function limitInBounds(name: TLimitName, value: number): boolean {
  const bounds = LIMIT_BOUNDS[name]
  return Number.isInteger(value) && ((bounds.unlimited === true && value === UNLIMITED) || (value >= bounds.min && value <= bounds.max))
}

/** Só os inteiros dentro da faixa; o resto é descartado (documento editado à mão não derruba a leitura). */
export function normalizeLimits(raw: unknown): ILimits | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const stored = raw as Record<string, unknown>
  const limits: ILimits = {}
  for (const name of LIMIT_NAMES) {
    const value = stored[name]
    if (typeof value === 'number' && limitInBounds(name, value)) limits[name] = value
  }

  return Object.keys(limits).length ? limits : undefined
}

/**
 * Os limites em vigor neste processo — espelho de `settings.limits`, atualizado a cada gravação.
 *
 * ⚖️ UM ESPELHO SÍNCRONO, e não uma leitura do repositório: quem pergunta (o adapter, o `run_bash`)
 * pergunta no meio de um turno, sem `await`. A composição o liga ao repositório (ver `makeSettings`).
 */
let live: ILimits = {}

export function applyLimits(limits: ILimits | undefined): void {
  live = { ...(normalizeLimits(limits) ?? {}) }
}

/** O valor configurado na tela, ou `undefined` (vale o `.env` ou o padrão de quem pergunta). */
export function liveLimit(name: TLimitName): number | undefined {
  return live[name]
}
