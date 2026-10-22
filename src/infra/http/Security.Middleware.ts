import cors, { CorsOptions } from 'cors'
import { NextFunction, Request, RequestHandler, Response } from 'express'
import { tokenFromHeader } from '@infra/mcp/Caller.Identity'
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

/** O header com a credencial do PRÓPRIO chamador — a que o gateway repassa às tools. */
export const CALLER_HEADER = 'x-tool-authorization'

/**
 * ⛔ EXIGE A CREDENCIAL DE QUEM CHAMA — fechado por padrão, com escape explícito.
 *
 * O `GATEWAY_TOKEN` é a chave do SERVIÇO, e quem fica na frente do gateway (um proxy que injeta o
 * token para não deixá-lo no bundle do navegador) a satisfaz em nome de TODO MUNDO. O efeito, que é
 * fácil de não medir: qualquer pessoa que alcance o proxy ganha um cano autenticado até aqui — e
 * um `curl` anônimo criaria sessão e faria o agente rodar, gastando de verdade.
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
