import { TErrorCode } from './Http.Error'

export interface IHttpResponse<T = unknown> {
  ok: boolean
  message?: string
  result?: T
  /** Presente só em falha: código estável, pensado para o cliente ramificar. */
  code?: TErrorCode
  /** Presente só em falha: o campo que não passou na validação, por exemplo. */
  details?: unknown
}

export function ok<T>(result?: T, message?: string): IHttpResponse<T> {
  return { ok: true, message, result }
}

export function fail(message: string, code: TErrorCode = 'internal_error', details?: unknown): IHttpResponse<null> {
  return { ok: false, message, code, details }
}
