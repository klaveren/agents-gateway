import { createHmac } from 'node:crypto'

type TFetch = typeof fetch

/** O que o aviso de fim de turno leva: nada do texto, só o que quem chama precisa para seguir. */
export interface ITurnCallbackPayload {
  conversationId: string
  turn: number
  status: 'ok' | 'error' | 'aborted'
  error?: string
  usage?: unknown
  durationMs: number
}

export const CALLBACK_SIGNATURE_HEADER = 'X-Gateway-Signature'

/** Os hosts para onde o aviso pode ir (`TURN_CALLBACK_HOSTS`: `host` ou `host:porta`, separados por vírgula). */
export function callbackHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TURN_CALLBACK_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * ⛔ O AVISO SÓ VAI PARA HOST LISTADO, e só com o segredo configurado: sem a lista, o gateway faria POST para qualquer
 * endereço que quem abre a conversa escolhesse (SSRF: a rede interna, o metadado da nuvem). Sem `TURN_CALLBACK_SECRET`,
 * quem recebe não teria como saber que veio daqui.
 */
export function callbackAllowed(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.TURN_CALLBACK_SECRET?.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password) return false
  const host = parsed.hostname.toLowerCase()
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  return callbackHosts(env).some((entry) => entry === host || entry === `${host}:${port}`)
}

/** A assinatura do corpo: `sha256=<hex>` do HMAC-SHA256 com o segredo da instalação. */
export function signCallback(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/**
 * Entrega o aviso: POST JSON assinado, até 3 tentativas (1s e 3s entre elas). Nunca lança — o turno já acabou e foi
 * gravado; o aviso perdido fica no log, e quem chama ainda tem o `GET` do turno.
 */
export async function deliverCallback(
  url: string,
  payload: ITurnCallbackPayload,
  options: { env?: NodeJS.ProcessEnv; http?: TFetch; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const env = options.env ?? process.env
  const http = options.http ?? fetch
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const secret = env.TURN_CALLBACK_SECRET?.trim()
  if (!secret || !callbackAllowed(url, env)) return false
  const body = JSON.stringify(payload)
  const delays = [0, 1000, 3000]
  for (const [attempt, delay] of delays.entries()) {
    if (delay) await wait(delay)
    try {
      const response = await http(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [CALLBACK_SIGNATURE_HEADER]: signCallback(body, secret) },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: 'manual',
      })
      if (response.ok) return true
      console.warn(`[turn-callback] ${url} respondeu ${response.status} (tentativa ${attempt + 1})`)
    } catch (error: unknown) {
      console.warn(`[turn-callback] ${url} falhou (tentativa ${attempt + 1}):`, error instanceof Error ? error.message : String(error))
    }
  }
  return false
}
