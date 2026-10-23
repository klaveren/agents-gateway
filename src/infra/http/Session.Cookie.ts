import { NextFunction, Request, RequestHandler, Response } from 'express'
import { HttpError } from './Http.Error'
import { fail } from './Http.Response'
import { CALLER_HEADER } from './Security.Middleware'

/**
 * A sessão da TELA num cookie `HttpOnly`: o JavaScript da página nunca vê o token, e um XSS não o leva.
 * Quem fala com a API por fora (curl, MCP, outro sistema) segue mandando `X-Tool-Authorization` — o
 * cookie é só o jeito do navegador entregar a mesma credencial.
 *
 * ⚖️ O NOME LEVA A PORTA (`gw_session_3100`): cookie é por host, não por porta, e dois gateways em
 * `localhost` (3100 e 3102) sobrescreveriam a sessão um do outro.
 */
export function sessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return `gw_session_${Number.parseInt(env.PORT || '3000', 10)}`
}

/** `Secure` quando a página chega por https (ou `COOKIE_SECURE=1`, atrás de um proxy que termina o TLS). */
function secure(req: Request): boolean {
  return req.secure || process.env.COOKIE_SECURE?.trim() === '1'
}

export function setSessionCookie(req: Request, res: Response, session: { token: string; expiresAt: Date }): void {
  const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
  res.append('Set-Cookie', serialize(sessionCookieName(), session.token, { maxAge, secure: secure(req) }))
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.append('Set-Cookie', serialize(sessionCookieName(), '', { maxAge: 0, secure: secure(req) }))
}

function serialize(name: string, value: string, options: { maxAge: number; secure: boolean }): string {
  // ⛔ HttpOnly (fora do alcance do JS), SameSite=Strict (nunca vai em pedido que nasce em outro site), Path=/.
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${options.maxAge}`, ...(options.secure ? ['Secure'] : [])].join('; ')
}

export function readSessionCookie(req: Request): string | undefined {
  const name = sessionCookieName()
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at === -1 || part.slice(0, at).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(at + 1).trim()) || undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS']

/**
 * O cookie vira a credencial de sempre: sem `X-Tool-Authorization` no pedido, o token do cookie entra no
 * lugar dele — e daí para frente (prova, dono, repasse às tools) nada muda.
 *
 * ⛔ CSRF: credencial que veio do COOKIE só muda algo com `Origin` (ou `Referer`) desta mesma origem. O
 * `SameSite=Strict` já impede o envio a partir de outro site; isto é a segunda tranca, para navegador
 * antigo e para subdomínio irmão.
 */
export function cookieCredential(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.headers[CALLER_HEADER]) return next()
    const token = readSessionCookie(req)
    if (!token) return next()

    if (!SAFE_METHODS.includes(req.method) && !sameOrigin(req)) {
      const failure = new HttpError(403, 'forbidden', 'Cross-site request refused')
      res.status(failure.status).json(fail(failure.message, failure.code))
      return
    }
    req.headers[CALLER_HEADER] = `Bearer ${token}`
    next()
  }
}

/** O pedido saiu de uma página DESTA origem? Sem `Origin` nem `Referer` (fetch antigo), não. */
export function sameOrigin(req: Request): boolean {
  const source = req.headers.origin ?? req.headers.referer
  if (!source || !req.headers.host) return false
  try {
    return new URL(source).host === req.headers.host
  } catch {
    return false
  }
}

/** A tela pede a sessão SÓ no cookie: o token não volta no corpo, para o JavaScript nunca o ter. */
export function wantsCookieOnly(req: Request): boolean {
  return req.headers['x-gateway-client'] === 'web'
}
