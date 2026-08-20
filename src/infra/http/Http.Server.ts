import { AgentController } from './Agent.Controller'
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { toHttpFailure } from './Http.Error'
import { fail } from './Http.Response'
import { OPENAPI_DOCUMENT } from './Openapi.Schema'
import { corsMiddleware, host, jsonLimit, requireToken } from './Security.Middleware'

export const API_PREFIX = '/v1'

export type TRouteMethod = 'get' | 'post' | 'delete'

export interface IRoute {
  method: TRouteMethod
  /** Caminho sem o prefixo de versão, no estilo do Express (`/sessions/:id`). */
  path: string
  handler: RequestHandler
}

export class HttpServer {
  public readonly app: Express
  private readonly routes: IRoute[]

  constructor(controller: AgentController) {
    this.app = express()
    this.app.disable('x-powered-by')
    this.app.use(corsMiddleware())
    this.app.use(express.json({ limit: jsonLimit() }))
    this.app.use(express.static(resolvePublicDir()))

    this.routes = buildRoutes(controller)
    this.setupRoutes()
  }

  /** A tabela de rotas como dado, para o teste conferir contra o OpenAPI. */
  get routeTable(): ReadonlyArray<{ method: TRouteMethod; path: string }> {
    return this.routes.map(({ method, path: routePath }) => ({ method, path: routePath }))
  }

  private setupRoutes() {
    this.app.get(`${API_PREFIX}/openapi.json`, (_req, res) => {
      res.json(OPENAPI_DOCUMENT)
    })

    const guard = requireToken()
    for (const { method, path: routePath, handler } of this.routes) {
      this.app[method](`${API_PREFIX}${routePath}`, guard, handler)
    }

    // Último recurso: erro que escapou de um middleware (token, corpo malformado) ainda
    // sai no mesmo envelope que o resto da API.
    this.app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(error)
      const failure = toHttpFailure(error)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    })
  }

  start(port: number) {
    this.app.listen(port, host(), () => {
      console.log(`Gateway API listening on http://${host()}:${port}${API_PREFIX}`)
    })
  }
}

function buildRoutes(controller: AgentController): IRoute[] {
  return [
    { method: 'get', path: '/health', handler: controller.health },
    { method: 'get', path: '/agents', handler: controller.getAgents },
    { method: 'get', path: '/agents/:agentId/tools', handler: controller.getAgentTools },
    { method: 'get', path: '/tools', handler: controller.getTools },
    { method: 'post', path: '/sessions', handler: controller.createSession },
    { method: 'get', path: '/sessions', handler: controller.listSessions },
    { method: 'get', path: '/sessions/:id', handler: controller.getSession },
    { method: 'delete', path: '/sessions/:id', handler: controller.deleteSession },
    { method: 'post', path: '/sessions/:id/messages', handler: controller.sendMessage },
    { method: 'post', path: '/sessions/:id/cancel', handler: controller.cancelSession },
  ]
}

/**
 * O frontend não passa pelo `tsc`, então ele fica em `src/` mesmo depois do build.
 * Resolver a partir do `__dirname` faz o gateway subir de qualquer diretório — antes, com
 * `process.cwd()`, iniciar de outra pasta servia 404 em vez da UI.
 */
function resolvePublicDir(): string {
  const candidates = [path.resolve(__dirname, 'public'), path.resolve(__dirname, '../../../src/infra/http/public'), path.resolve(process.cwd(), 'src/infra/http/public')]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[candidates.length - 1]
}
