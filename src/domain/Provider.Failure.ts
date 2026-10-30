/**
 * ⚖️ POR QUE O TURNO FALHOU, do lado do provedor: é o que decide se vale tentar outro (ver `Fallback.Policy`). Cota e
 * limite de taxa passam para o próximo da cadeia; credencial errada, pedido inválido e o resto, não — outro provedor não
 * conserta um pedido quebrado, e trocar esconderia o problema.
 */
export type TProviderFailure = 'quota' | 'rate_limit' | 'overloaded' | 'auth' | 'other'

/** As falhas que mandam para o próximo da cadeia. `overloaded` fica: costuma passar em segundos, e o SDK já repete. */
export const FALLBACK_FAILURES: readonly TProviderFailure[] = ['quota', 'rate_limit']

const QUOTA = [
  /insufficient[_ ]quota/i,
  /quota (?:exceeded|exhausted)|exceeded (?:your|the) (?:current )?quota/i,
  /resource[_ ]exhausted/i,
  /usage limit/i,
  /(?:hit|reached) (?:your|the) (?:usage |weekly |daily |session )?limit/i,
  /out of credits|credit balance is too low|billing/i,
]
const RATE = [/rate[_ -]?limit/i, /too many requests/i, /\b429\b/]
const OVERLOADED = [/overloaded/i, /\b529\b/, /service unavailable|\b503\b/i]
const AUTH = [/\b401\b|unauthori[sz]ed|invalid (?:x-)?api[_ -]?key|authentication/i, /\b403\b|permission denied|forbidden/i]

/**
 * A falha de um erro de SDK ou de uma mensagem. O status HTTP, quando existe, vence o texto: 429 é limite (ou cota, se
 * o texto diz cota), 529 é sobrecarga, 401/403 é credencial.
 */
export function failureKind(error: unknown): TProviderFailure {
  const status = statusOf(error)
  const text = messageOf(error)
  if (QUOTA.some((pattern) => pattern.test(text))) return 'quota'
  if (status === 429 || RATE.some((pattern) => pattern.test(text))) return 'rate_limit'
  if (status === 529 || status === 503 || OVERLOADED.some((pattern) => pattern.test(text))) return 'overloaded'
  if (status === 401 || status === 403 || AUTH.some((pattern) => pattern.test(text))) return 'auth'
  return 'other'
}

/** O payload do evento `error` com a falha classificada (o `kind` só quando diz algo). */
export function errorPayload(error: unknown, message = messageOf(error)): { message: string; kind?: TProviderFailure; resetsAt?: string } {
  const kind = failureKind(error)
  const resetsAt = resetsAtOf(error)
  return { message, ...(kind !== 'other' ? { kind } : {}), ...(resetsAt ? { resetsAt } : {}) }
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  const status = record.status ?? record.statusCode ?? (record.response as Record<string, unknown> | undefined)?.status
  return typeof status === 'number' ? status : undefined
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return String(error ?? '')
}

/** Quando a cota volta, se o erro diz (`resetsAt` do Claude, cabeçalho `retry-after` em segundos). */
function resetsAtOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  if (typeof record.resetsAt === 'string') return record.resetsAt
  if (typeof record.resetsAt === 'number') return new Date(record.resetsAt * (record.resetsAt < 1e12 ? 1000 : 1)).toISOString()
  const headers = record.headers as Record<string, unknown> | { get?: (name: string) => string | null } | undefined
  const retry =
    typeof (headers as { get?: unknown })?.get === 'function'
      ? (headers as { get: (name: string) => string | null }).get('retry-after')
      : (headers as Record<string, unknown> | undefined)?.['retry-after']
  const seconds = Number(retry)
  return Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined
}
