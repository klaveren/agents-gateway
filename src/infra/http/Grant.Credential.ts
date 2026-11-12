import { NextFunction, Request, RequestHandler, Response } from 'express'
import { IDENTITY_HEADERS, identityHeaders } from '@domain/Agent.Identity'
import { TurnGrants, turnGrants } from '@infra/tools/Turn.Grants'
import { CALLER_HEADER, TURN_GRANT_LOCAL } from './Security.Middleware'
import { TURN_GRANT_HEADER } from './TurnTools.Controller'

/** As ÚNICAS rotas que a concessão do turno abre: as ferramentas do turno, o MCP do gateway e a ponte dos MCPs em contêiner. */
const GRANT_ROUTES: readonly RegExp[] = [/^\/v1\/turn-tools\/?$/, /^\/v1\/mcp\/?$/, /^\/v1\/mcp-proxy\/[^/]+\/?$/]

/**
 * ⛔ O AGENTE NUNCA RECEBE O TOKEN DE QUEM CONVERSA. O que ele leva para chamar o gateway (arquivo do plugin, argv do CLI)
 * é só o `X-Turn-Grant`: aleatório, preso a UM turno e válido só nas rotas acima. Aqui o servidor troca a concessão pela
 * identidade do dono do turno, por dentro: o cabeçalho da credencial é sobrescrito (o que o chamador mandou não vale
 * junto) e, daí para frente, a requisição é a de sempre. O contexto do turno (agente, conversa, projeto) fica em
 * `res.locals`, para o MCP do gateway recusar escrita fora do projeto da conversa.
 *
 * ⛔ A IDENTIDADE TAMBÉM É A DO TURNO. Os cabeçalhos de identidade (`Agent.Identity`) ficam na config do CLI ao lado da
 * concessão, ao alcance do agente: com a concessão, os que o chamador mandou saem e entram os do turno. Sem isto o agente
 * assinaria um pedido como outro agente, ou em nome de outra conversa.
 */
export function grantCredential(grants: TurnGrants = turnGrants()): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers[TURN_GRANT_HEADER]
    if (typeof header !== 'string' || !GRANT_ROUTES.some((route) => route.test(req.path))) return next()
    const grant = grants.get(header)
    if (!grant) return next()
    delete req.headers[CALLER_HEADER]
    if (grant.context.token) req.headers[CALLER_HEADER] = `Bearer ${grant.context.token}`
    for (const name of Object.values(IDENTITY_HEADERS)) delete req.headers[name]
    Object.assign(req.headers, identityHeaders(grant.context))
    res.locals[TURN_GRANT_LOCAL] = grant.context
    next()
  }
}
