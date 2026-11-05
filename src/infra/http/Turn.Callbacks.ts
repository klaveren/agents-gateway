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
  /** O agente que respondeu: quem orquestra vários sabe de quem é o turno sem ler a conversa. */
  agentId: string
  /** A `metadata` que quem abriu a conversa declarou (sem as chaves do servidor): o `epicCode` volta junto. */
  metadata: Record<string, unknown>
  /** O fim do turno, ISO. Vai assinado: quem recebe recusa aviso velho (repetição). */
  at: string
}

export const CALLBACK_SIGNATURE_HEADER = 'X-Gateway-Signature'

/** Os hosts para onde o aviso pode ir (`TURN_CALLBACK_HOSTS`: `host` ou `host:porta`, separados por vírgula). */
export function callbackHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TURN_CALLBACK_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

/** O `host:porta` de uma URL de aviso (com a porta padrão do esquema), ou nada se ela não serve. */
export function callbackTarget(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.username || parsed.password) return undefined
  return `${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`
}

/**
 * ⛔ O AVISO SÓ VAI PARA ENDEREÇO CADASTRADO, e sempre assinado: sem isso, o gateway faria POST para qualquer endereço que
 * quem abre a conversa escolhesse (SSRF: a rede interna, o metadado da nuvem), e quem recebe não saberia que veio daqui.
 *
 * O segredo de um endereço, nesta ordem:
 * 1. o do projeto da conversa (a conta `turn-callback` daquele endereço, na tela do projeto);
 * 2. o da instalação: `TURN_CALLBACK_HOSTS` (`host` ou `host:porta`, separados por vírgula) e `TURN_CALLBACK_SECRET`.
 * Nenhum dos dois = o endereço não serve.
 */
export function callbackSecret(url: string, project?: (host: string) => string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const target = callbackTarget(url)
  if (!target) return undefined
  const own = project?.(target)
  if (own) return own
  const secret = env.TURN_CALLBACK_SECRET?.trim()
  if (!secret) return undefined
  const host = target.split(':')[0]
  return callbackHosts(env).some((entry) => entry === host || entry === target) ? secret : undefined
}

/** O endereço serve para o aviso (com o segredo do projeto ou o da instalação)? */
export function callbackAllowed(url: string, env: NodeJS.ProcessEnv = process.env, project?: (host: string) => string | undefined): boolean {
  return callbackSecret(url, project, env) !== undefined
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
  options: { env?: NodeJS.ProcessEnv; http?: TFetch; wait?: (ms: number) => Promise<void>; secretFor?: (url: string) => string | undefined } = {},
): Promise<boolean> {
  const env = options.env ?? process.env
  const http = options.http ?? fetch
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // O segredo é lido na hora da entrega: trocado na tela, o próximo aviso já sai com o novo.
  const secret = options.secretFor ? options.secretFor(url) : callbackSecret(url, undefined, env)
  if (!secret) return false
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
