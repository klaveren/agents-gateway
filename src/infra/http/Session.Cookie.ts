import { createHash, timingSafeEqual } from 'node:crypto'
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

/** O cookie do CSRF, LEGÍVEL pelo JavaScript da tela (que o devolve no cabeçalho `X-CSRF`). Também leva a porta. */
export function csrfCookieName(env: NodeJS.ProcessEnv = process.env): string {
  return `gw_csrf_${Number.parseInt(env.PORT || '3000', 10)}`
}

/** O cabeçalho em que a tela devolve o valor do cookie do CSRF. */
export const CSRF_HEADER = 'x-csrf'

/**
 * ⛔ O valor do CSRF é derivado da sessão (sem estado: sobrevive a reinício). Só quem tem o token da sessão o calcula — e o
 * token nunca chega ao agente (ver `Grant.Credential`) —, então forjar cookie + cabeçalho à mão (`curl`) não basta.
 */
export function csrfOf(sessionToken: string): string {
  return createHash('sha256').update(`gateway-csrf\0${sessionToken}`).digest('base64url')
}

export function setSessionCookie(req: Request, res: Response, session: { token: string; expiresAt: Date }): void {
  const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000))
  res.append('Set-Cookie', serialize(sessionCookieName(), session.token, { maxAge, secure: secure(req) }))
  res.append('Set-Cookie', serialize(csrfCookieName(), csrfOf(session.token), { maxAge, secure: secure(req), httpOnly: false }))
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.append('Set-Cookie', serialize(sessionCookieName(), '', { maxAge: 0, secure: secure(req) }))
  res.append('Set-Cookie', serialize(csrfCookieName(), '', { maxAge: 0, secure: secure(req), httpOnly: false }))
}

function serialize(name: string, value: string, options: { maxAge: number; secure: boolean; httpOnly?: boolean }): string {
  // ⛔ HttpOnly (fora do alcance do JS; só o do CSRF é legível), SameSite=Strict (nunca vai em pedido que nasce em outro site), Path=/.
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    ...(options.httpOnly === false ? [] : ['HttpOnly']),
    'SameSite=Strict',
    `Max-Age=${options.maxAge}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
}

export function readSessionCookie(req: Request): string | undefined {
  return readCookie(req, sessionCookieName())
}

function readCookie(req: Request, name: string): string | undefined {
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
    res.locals[VIA_SESSION_COOKIE] = browserProof(req, token)
    // Sessão aberta antes do CSRF existir: o cookie dele nasce no próximo pedido seguro (a tela o lê dali).
    if (SAFE_METHODS.includes(req.method) && !readCookie(req, csrfCookieName())) {
      res.append('Set-Cookie', serialize(csrfCookieName(), csrfOf(token), { maxAge: 12 * 60 * 60, secure: secure(req), httpOnly: false }))
    }
    next()
  }
}

/**
 * ⛔ PROVA DE NAVEGADOR, para o que é "só pela tela": além de `Origin` = `Host` (que `curl` forja, os dois são de quem
 * chama), o navegador mente pouco em `Sec-Fetch-*` (o `curl` não os manda) e a tela devolve o CSRF do cookie no
 * `X-CSRF` — valor que só quem tem o token da sessão calcula.
 */
function browserProof(req: Request, token: string): boolean {
  if (!sameOrigin(req)) return false
  // ⚠️ Fora de HTTPS o navegador NÃO manda os `Sec-Fetch-*` (só a origem confiável os recebe): com a tela da .4 em http,
  // ninguém aprovava pedido de permissão desde 06/11. Lá, a prova é a origem e o CSRF do cookie (que agente nenhum tem);
  // em HTTPS, ou quando eles vêm, os `Sec-Fetch-*` valem como antes.
  const site = req.headers['sec-fetch-site']
  const mode = req.headers['sec-fetch-mode']
  if (secure(req) || site !== undefined || mode !== undefined) {
    if (site !== 'same-origin') return false
    if (mode !== 'cors' && mode !== 'same-origin') return false
  }
  const sent = req.headers[CSRF_HEADER]
  if (typeof sent !== 'string') return false
  const expected = Buffer.from(csrfOf(token))
  const given = Buffer.from(sent)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Marca, em `res.locals`, que a credencial veio do COOKIE da tela (e não de um cabeçalho). */
const VIA_SESSION_COOKIE = 'viaSessionCookie'

/**
 * A credencial veio do cookie HttpOnly da tela, sem `X-Tool-Authorization` no pedido — é a pessoa no navegador. ⛔ É a
 * régua do que só a pessoa na tela faz (aprovar pedido de permissão): o agente, o MCP do gateway, o cliente MCP e o
 * token de acesso chegam pelo cabeçalho, e o cabeçalho sempre vence o cookie (ver `cookieCredential`).
 */
export function viaSessionCookie(res: Response): boolean {
  return res.locals[VIA_SESSION_COOKIE] === true
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
