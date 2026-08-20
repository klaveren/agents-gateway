import cors, { CorsOptions } from 'cors'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { HttpError } from './Http.Error'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_JSON_LIMIT = '25mb'

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

/**
 * Exige `Authorization: Bearer` quando `GATEWAY_TOKEN` está definido.
 *
 * Desligado por default para não atrapalhar o uso local; ligue quando o gateway sair de
 * `127.0.0.1`.
 */
export function requireToken(token = process.env.GATEWAY_TOKEN): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!token) return next()

    const header = req.headers.authorization
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined

    if (presented !== token) {
      return next(new HttpError(401, 'unauthorized', 'Missing or invalid bearer token'))
    }

    return next()
  }
}
