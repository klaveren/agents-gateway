import { liveLimit, TLimitName } from './models/Limits.Model'

/**
 * ⚖️ O DETECTOR DE LAÇO: o agente que repete a MESMA chamada (ferramenta + argumentos) no mesmo turno não vai ver um
 * resultado diferente. Antes, só o teto de `maxToolTurns` o parava — depois de gastar todos os passos.
 *
 * - a chamada idêntica de número `loopRefuseAt` (4) é RECUSADA, com o motivo, para o modelo mudar de rumo;
 * - a de número `loopStopAt` (6), ou `loopMaxErrors` (8) erros de ferramenta seguidos, PARAM o turno.
 *
 * Quem conta é o `LoopGuard`, por conversa e por turno (ver `Loop.Guard`).
 */

const DEFAULTS = { loopRefuseAt: 4, loopStopAt: 6, loopMaxErrors: 8 } as const satisfies Partial<Record<TLimitName, number>>
const ENV = { loopRefuseAt: 'LOOP_REFUSE_AT', loopStopAt: 'LOOP_STOP_AT', loopMaxErrors: 'LOOP_MAX_ERRORS' } as const

export interface ILoopLimits {
  refuseAt: number
  stopAt: number
  maxErrors: number
}

/** Os limites em vigor: os das configurações, senão os do `.env`, senão os padrões. */
export function loopLimits(env: NodeJS.ProcessEnv = process.env): ILoopLimits {
  const read = (name: keyof typeof DEFAULTS): number => {
    const configured = liveLimit(name)
    if (configured !== undefined) return configured
    const parsed = Number.parseInt(env[ENV[name]] ?? '', 10)
    return Number.isFinite(parsed) && parsed >= 2 ? parsed : DEFAULTS[name]
  }
  return { refuseAt: read('loopRefuseAt'), stopAt: read('loopStopAt'), maxErrors: read('loopMaxErrors') }
}

/** A assinatura da chamada: a ferramenta e os argumentos em JSON com as chaves em ordem (a ordem não muda a chamada). */
export function callSignature(tool: string, args: unknown): string {
  return `${tool} ${stableJson(args)}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

/** O texto da recusa: o que o modelo lê no lugar do resultado. */
export function loopRefusal(times: number): string {
  return `Recusado pelo detector de laço: você já fez esta mesma chamada ${times} vezes neste turno, e o resultado não muda. Mude a abordagem ou responda com o que já sabe.`
}
