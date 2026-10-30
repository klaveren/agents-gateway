import { createHash, timingSafeEqual } from 'node:crypto'
import cors, { CorsOptions } from 'cors'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { tokenFromHeader } from '@infra/mcp/Caller.Identity'
import { HttpError } from './Http.Error'

export const DEFAULT_HOST = '127.0.0.1'
/** ⛔ O corpo de QUALQUER rota: pequeno. Ele é lido antes da autenticação, então é o que um anônimo manda. */
export const DEFAULT_JSON_LIMIT = '256kb'
/** O teto grande: a mensagem de uma conversa (anexo em base64) e as rotas que gravam conteúdo (ver `Http.Server`). */
export const DEFAULT_MESSAGE_JSON_LIMIT = '25mb'

export function messageJsonLimit(): string {
  return process.env.MESSAGE_JSON_LIMIT || DEFAULT_MESSAGE_JSON_LIMIT
}

/**
 * ⛔ Os cabeçalhos do navegador. `frame-ancestors 'none'` e `X-Frame-Options`: a tela de admin não abre
 * dentro do site de outro (clickjacking). A CSP só deixa rodar o que vem desta origem — um XSS que
 * escape do markdown não carrega script de fora nem manda o token para outro lugar.
 */
export function securityHeaders(): RequestHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ')
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp)
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    // A API nunca vai para cache: as respostas carregam conversa, uso e configuração.
    if (req.path.startsWith('/v1')) res.setHeader('Cache-Control', 'no-store')
    next()
  }
}

/**
 * ⛔ Limite por ORIGEM (`clientIp`: o socket, ou o IP real se o proxy for confiável): `max` pedidos por janela.
 * Em memória, com teto de origens rastreadas. É o que segura quem troca de e-mail a cada tentativa de
 * login, e quem martela o setup.
 */
export function rateLimit(options: { windowMs: number; max: number; key?: (req: Request) => string }, now: () => number = Date.now): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req, res, next) => {
    // Padrão: por origem (IP). `key` troca o balde — o hook conta por hook, venha de onde vier.
    const origin = options.key ? options.key(req) : clientIp(req)
    const at = now()
    const current = hits.get(origin)
    const entry = current && current.resetAt > at ? current : { count: 0, resetAt: at + options.windowMs }
    entry.count += 1
    hits.set(origin, entry)
    if (hits.size > 10_000) for (const [key, value] of hits) if (value.resetAt <= at) hits.delete(key)

    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - at) / 1000)))
      res.status(429).json({ ok: false, message: 'Too many requests', code: 'rate_limited' })
      return
    }
    next()
  }
}

/** Os nomes de faixa que o `proxy-addr` (o `trust proxy` do Express) entende. */
const PROXY_NAMES = ['loopback', 'linklocal', 'uniquelocal']
const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
const IPV6_CIDR = /^[0-9a-f:]+(\/\d{1,3})?$/i
/** Confiar nestes = confiar em qualquer um: o `X-Forwarded-For` voltaria a ser escrito pelo atacante. */
const TRUST_EVERYONE = ['0.0.0.0/0', '::/0', '::/1', '0.0.0.0/1']

/**
 * ⛔ Em QUEM o gateway confia para dizer o IP real (`X-Forwarded-For`) e o protocolo (`X-Forwarded-Proto`):
 * só nos proxies listados em `TRUST_PROXY` — IPs, CIDRs ou `loopback`/`linklocal`/`uniquelocal`.
 * Sem a variável, ninguém: vale o endereço do socket, que é o certo sem proxy na frente.
 */
export function trustProxyIssue(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  if (/^(true|\*|\d+)$/i.test(value)) return `TRUST_PROXY=${value} would trust any client: list the proxy addresses or CIDRs (e.g. 10.42.0.0/16)`
  for (const entry of value.split(',').map((part) => part.trim())) {
    if (TRUST_EVERYONE.includes(entry)) return `TRUST_PROXY entry ${entry} trusts the whole internet`
    if (!PROXY_NAMES.includes(entry) && !IPV4_CIDR.test(entry) && !IPV6_CIDR.test(entry)) return `TRUST_PROXY entry is not an IP, CIDR or ${PROXY_NAMES.join('/')}: ${entry}`
  }
  return undefined
}

/** O valor do `trust proxy` do Express, ou `undefined` (desligado). */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const value = env.TRUST_PROXY?.trim()
  if (!value || trustProxyIssue(value)) return undefined
  return value.split(',').map((part) => part.trim())
}

/**
 * O IP de quem chama: `req.ip`, que com `TRUST_PROXY` é o primeiro endereço NÃO confiável do
 * `X-Forwarded-For` (lido da direita) e, sem ele, o do socket. Um só lugar para limite e trava de login.
 */
export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || ''
}

/** Compara dois segredos sem vazar, pelo tempo, quantos caracteres batem. */
export function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

export function host(): string {
  return process.env.HOST || DEFAULT_HOST
}

export function jsonLimit(): string {
  return process.env.JSON_LIMIT || DEFAULT_JSON_LIMIT
}

/**
 * Sem allowlist, nenhuma origem cruzada é aceita.
 *
 * A UI embutida é servida pelo próprio gateway, então é same-origin e não precisa de CORS.
 * O default antigo (`cors()` sem argumento) liberava qualquer origem — e como o gateway
 * executa `run_bash`, qualquer página aberta no navegador podia criar uma sessão aqui,
 * rodar comando na máquina e ler a saída.
 */
export function corsOptions(): CorsOptions {
  const allowed = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (allowed.length === 0) return { origin: false }
  return { origin: allowed, credentials: true }
}

export function corsMiddleware(): RequestHandler {
  return cors(corsOptions())
}

/** O header com a credencial do PRÓPRIO chamador — a que o gateway repassa às tools. */
export const CALLER_HEADER = 'x-tool-authorization'

/**
 * ⛔ EXIGE A CREDENCIAL DE QUEM CHAMA — fechado por padrão, com escape explícito.
 *
 * Sem ela, qualquer um que alcance a porta (ou um proxy na frente) teria um cano até aqui — e um
 * `curl` anônimo criaria sessão e faria o agente rodar, gastando de verdade.
 *
 * ⚠️ CORS NÃO RESOLVE ISTO, e é a conclusão errada mais fácil de tirar: ele impede o NAVEGADOR de
 * ler resposta de outra origem; `curl` não tem navegador e ignora tudo.
 *
 * ⚖️ CONFERE PRESENÇA, não validade. Provar custa uma chamada real, e as rotas que dependem de
 * identidade já resolvem o chamador (`resolveCaller`). Aqui basta fechar a porta para quem não
 * apresenta nada — é de graça, e é o caso que ficava aberto.
 *
 * ⚖️ FECHADO POR PADRÃO. Uma trava opt-in vale em lugar nenhum: o deploy nasce aberto porque
 * ninguém ligou uma variável. `ALLOW_ANONYMOUS=1` reabre, de propósito, para o `curl` local e a UI
 * de demonstração.
 *
 * ⚠️ QUEM É PÚBLICO NÃO PASSA POR AQUI: este middleware simplesmente não é anexado àquelas rotas
 * (ver `PUBLIC_PATHS` em `Http.Server`). Casar caminho aqui dentro dependeria de `req.route.path`,
 * que traz o prefixo de versão — e um dia alguém mexe no prefixo e abre a API sem perceber.
 */
export function requireCaller(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Lido a cada chamada, não uma vez no boot: o teste liga e desliga entre casos.
    if (process.env.ALLOW_ANONYMOUS === '1') return next()
    if (tokenFromHeader(req.headers[CALLER_HEADER])) return next()

    // 401, e não 404: aqui a ausência de credencial é a resposta honesta — não há id nenhum a proteger.
    return next(new HttpError(401, 'unauthorized', 'Missing caller credential'))
  }
}
