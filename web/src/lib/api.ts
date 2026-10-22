import { readLocal } from './storage'

export const GATEWAY_TOKEN_KEY = 'gatewayToken'
export const CALLER_TOKEN_KEY = 'callerToken'

/** Erro da API no envelope do gateway: status, código e — na validação — os problemas campo a campo. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }

  /** Os problemas de um 422, por campo (`{ field, message }[]` do gateway). */
  get fieldIssues(): Record<string, string[]> {
    const issues: Record<string, string[]> = {}
    if (!Array.isArray(this.details)) return issues
    for (const item of this.details as Array<{ field?: string; message?: string }>) {
      // `models.0` é problema do campo `models`: a tela marca o campo, não o item.
      const field = (item.field ?? '_').split('.')[0]
      ;(issues[field] ??= []).push(item.message ?? 'invalid')
    }
    return issues
  }
}

/**
 * Os dois cabeçalhos do gateway: o portão do serviço (`GATEWAY_TOKEN`) e a credencial de quem chama,
 * repassada às tools. Os dois vêm da tela de configuração, guardados neste navegador.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extra }
  const gateway = readLocal(GATEWAY_TOKEN_KEY)
  const callerToken = readLocal(CALLER_TOKEN_KEY)
  if (gateway) headers.Authorization = `Bearer ${gateway}`
  if (callerToken) headers['X-Tool-Authorization'] = `Bearer ${callerToken}`
  return headers
}

interface IRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
  signal?: AbortSignal
}

export function url(path: string, query?: IRequest['query']): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined && value !== '') params.set(key, String(value))
  const search = params.toString()
  return `/v1${path}${search ? `?${search}` : ''}`
}

/** Uma chamada à API: abre o envelope `{ ok, result }` ou lança `ApiError`. */
export async function api<T>(path: string, request: IRequest = {}): Promise<T> {
  const response = await fetch(url(path, request.query), {
    method: request.method ?? 'GET',
    headers: authHeaders(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  })

  const envelope = (await response.json().catch(() => undefined)) as { ok?: boolean; result?: T; message?: string; code?: string; details?: unknown } | undefined
  if (!response.ok || !envelope?.ok) throw new ApiError(response.status, envelope?.code, envelope?.message ?? `HTTP ${response.status}`, envelope?.details)

  return envelope.result as T
}

/** Abre um stream SSE autenticado (POST com corpo, ou GET). */
export async function openStream(path: string, request: IRequest = {}): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(url(path, request.query), {
    method: request.method ?? 'GET',
    headers: authHeaders({ Accept: 'text/event-stream', ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) }),
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: request.signal,
  })

  if (!response.ok || !response.body) {
    const envelope = (await response.json().catch(() => undefined)) as { message?: string; code?: string } | undefined
    throw new ApiError(response.status, envelope?.code, envelope?.message ?? `HTTP ${response.status}`)
  }

  return response.body
}
