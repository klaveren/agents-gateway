export interface IHttpResponse<T = any> {
  ok: boolean
  message?: string
  result?: T
}

export function ok<T>(result?: T, message?: string): IHttpResponse<T> {
  return { ok: true, message, result }
}

export function fail(message: string): IHttpResponse<null> {
  return { ok: false, message }
}
