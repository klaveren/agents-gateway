/** ⚠️ Só para a migração: a sessão de antes ficava aqui. Hoje ela mora num cookie HttpOnly (ver `auth.ts`). */
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
 * Os cabeçalhos da tela: a marca de que quem chama é a tela.
 *
 * ⛔ A SESSÃO NÃO PASSA POR AQUI: ela vai no cookie HttpOnly, que o navegador manda sozinho e o
 * JavaScript não lê. A marca `X-Gateway-Client: web` faz o login devolver a sessão só no cookie.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, 'X-Gateway-Client': 'web' }
}

interface IRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
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

let onUnauthorized: (() => void) | undefined

/**
 * Quem cuida da sessão quando o gateway recusa a credencial (401): a sessão venceu, a conta foi
 * desativada ou o papel mudou. A tela limpa o token e volta ao login, em vez de mostrar listas vazias.
 */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

function checkUnauthorized(status: number): void {
  if (status === 401) onUnauthorized?.()
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
  if (!response.ok || !envelope?.ok) {
    checkUnauthorized(response.status)
    throw new ApiError(response.status, envelope?.code, envelope?.message ?? `HTTP ${response.status}`, envelope?.details)
  }

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
    checkUnauthorized(response.status)
    throw new ApiError(response.status, envelope?.code, envelope?.message ?? `HTTP ${response.status}`)
  }

  return response.body
}
