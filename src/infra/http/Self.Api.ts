import { Request } from 'express'

export interface ISelfReply {
  ok: boolean
  status: number
  result?: unknown
  message?: string
  code?: string
  details?: unknown
}

export type TSelfApi = (method: string, path: string, options?: { body?: unknown; query?: Record<string, string | number | undefined> }) => Promise<ISelfReply>

/** A base da API deste processo, pelo endereço em que a requisição chegou (`http://<local>:<porta>/v1`). */
export function selfBase(req: Request): string {
  const address = req.socket.localAddress?.replace(/^::ffff:/, '') || '127.0.0.1'
  return `http://${address.includes(':') ? `[${address}]` : address}:${req.socket.localPort}/v1`
}

/**
 * A API do gateway chamada DE DENTRO dele, com uma credencial.
 *
 * ⚖️ AS REGRAS MORAM NOS CONTROLLERS — dono da conversa, audiência, carimbo do `owner`, DTO sem prompt e sem
 * custo para quem não administra. Passar pela API é o que garante que quem chama por aqui (o MCP do gateway,
 * os hooks) segue as MESMAS regras, sem uma segunda cópia que um dia divergiria. O preço é um salto local.
 */
export function selfApi(base: string, credentials: Record<string, string>): TSelfApi {
  return async (method, path, options = {}) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined && value !== '') query.set(key, String(value))
    const url = `${base}${path}${query.size ? `?${query}` : ''}`

    const response = await fetch(url, {
      method,
      headers: { ...credentials, Accept: 'application/json', ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const envelope = (await response.json().catch(() => ({}))) as Omit<ISelfReply, 'status'>
    return { ...envelope, ok: response.ok && envelope.ok !== false, status: response.status }
  }
}
