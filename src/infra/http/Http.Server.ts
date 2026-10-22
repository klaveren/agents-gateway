import { AgentController } from './Agent.Controller'
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { toHttpFailure } from './Http.Error'
import { fail } from './Http.Response'
import { OPENAPI_DOCUMENT } from './Openapi.Schema'
import { identityFromToken, tokenFromHeader, withCaller } from '@infra/mcp/Caller.Identity'
import { CALLER_HEADER, corsMiddleware, host, jsonLimit, requireCaller, requireToken } from './Security.Middleware'

export const API_PREFIX = '/v1'

/**
 * As ÚNICAS rotas que respondem sem credencial de quem chama (com o portão do serviço, se houver).
 *
 * ⚖️ CURTA PARA CABER NUM OLHAR: ninguém abre uma rota por distração. `/health` é o que o
 * orquestrador e o monitor chamam, e não tem credencial de usuário nenhuma. Fora ele:
 *
 * · `/shared/:id` é a conversa que alguém abriu por link, para quem não tem conta: o `:id` é o `shareId`
 * (o segredo do link), a resposta é só leitura e só a projeção pública, e fechar o compartilhamento a
 * revoga.
 *
 * Rota pública nova entra aqui — e só aqui, de propósito.
 */
export const PUBLIC_PATHS: readonly string[] = ['/health', '/shared/:id']

export type TRouteMethod = 'get' | 'post' | 'put' | 'delete'

export interface IRoute {
  method: TRouteMethod
  /** Caminho sem o prefixo de versão, no estilo do Express (`/sessions/:id`). */
  path: string
  handler: RequestHandler
}

export class HttpServer {
  public readonly app: Express
  private readonly routes: IRoute[]

  constructor(private readonly controller: AgentController) {
    this.app = express()
    this.app.disable('x-powered-by')
    this.app.use(corsMiddleware())
    this.app.use(express.json({ limit: jsonLimit() }))

    this.routes = buildRoutes(controller)
    this.setupRoutes()
    this.setupFrontend()
  }

  /**
   * A tela: a nova (Vue, `web/dist`) na raiz e a antiga em `/legacy`, enquanto as duas convivem.
   *
   * ⚖️ DEPOIS DA API, de propósito: o fallback do SPA devolve `index.html` para qualquer GET que
   * peça HTML, e registrado antes ele responderia no lugar de uma rota da API. Rota desconhecida em
   * `/v1` continua sendo da API (404 dela), nunca a tela.
   *
   * Sem `web/dist` (o front não foi compilado), a antiga volta para a raiz — o gateway nunca sobe sem tela.
   */
  private setupFrontend() {
    const legacy = resolvePublicDir()
    const web = resolveWebDir()

    this.app.use('/legacy', express.static(legacy))
    if (!web) {
      this.app.use(express.static(legacy))
      return
    }

    this.app.use(express.static(web, { index: false }))
    this.app.get(/^(?!\/v1(\/|$)|\/legacy(\/|$)).*/, (req, res, next) => {
      if (!req.accepts('html')) return next()
      res.sendFile(path.join(web, 'index.html'))
    })
  }

  /** A tabela de rotas como dado, para o teste conferir contra o OpenAPI. */
  get routeTable(): ReadonlyArray<{ method: TRouteMethod; path: string }> {
    return this.routes.map(({ method, path: routePath }) => ({ method, path: routePath }))
  }

  private setupRoutes() {
    /**
     * Abre o escopo da credencial de quem chamou, e o mantém pelo turno inteiro.
     *
     * ⚠️ ENVOLVE O HANDLER, não só o começo dele. Um turno agêntico é um stream que vive minutos: o
     * SDK do provider chama a tool, a tool chama o MCP, e é ali no fundo que a credencial é usada.
     * Encerrar o escopo antes disso faria a chamada cair no que estiver configurado no ambiente do
     * MCP — que pode ser a conta de outra pessoa.
     *
     * ⚖️ HEADER SEPARADO do `Authorization`, de propósito. O `Authorization` é o portão do próprio
     * gateway (`GATEWAY_TOKEN`); este é a credencial que o gateway REPASSA às ferramentas. Misturar
     * os dois faria o portão do serviço virar a identidade do usuário, ou o contrário.
     *
     * ⛔ E é a ÚNICA fonte de identidade. Nada que venha no corpo ou na query pode dizer quem o
     * chamador é: seria pedir para a pessoa declarar a própria conta.
     */
    const callerScope = (req: Request, _res: Response, next: NextFunction) => {
      const token = tokenFromHeader(req.headers[CALLER_HEADER])

      // ⚠️ A identidade lida aqui é só RÓTULO (o token não é verificado). Quem decide acesso passa por
      // `resolveCaller`, que exige a prova.
      return withCaller(token ? { token, ...identityFromToken(token) } : {}, () => next())
    }

    const guard = requireToken()
    const identity = requireCaller()

    // O contrato também é fechado: entrega o mapa de todas as rotas, e presença de header não é
    // identidade — então passa pelo mesmo portão e pela mesma resolução do chamador.
    this.app.get(`${API_PREFIX}/openapi.json`, guard, identity, callerScope, this.controller.guardCaller, (_req, res) => {
      res.json(OPENAPI_DOCUMENT)
    })

    for (const { method, path: routePath, handler } of this.routes) {
      const chain = PUBLIC_PATHS.includes(routePath) ? [guard, callerScope, handler] : [guard, identity, callerScope, handler]
      this.app[method](`${API_PREFIX}${routePath}`, ...chain)
    }

    // Último recurso: erro que escapou de um middleware (token, corpo malformado) ainda
    // sai no mesmo envelope que o resto da API.
    this.app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) return next(error)
      const failure = toHttpFailure(error)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    })
  }

  /** Devolve o servidor para quem sobe poder derrubar — é o que torna o teste de integração possível. */
  start(port: number): Server {
    return this.app.listen(port, host(), () => {
      console.log(`Gateway API listening on http://${host()}:${port}${API_PREFIX}`)
    })
  }
}

function buildRoutes(controller: AgentController): IRoute[] {
  return [
    { method: 'get', path: '/health', handler: controller.health },
    { method: 'get', path: '/agents', handler: controller.getAgents },
    { method: 'post', path: '/agents', handler: controller.createAgent },
    { method: 'get', path: '/agents/:agentId', handler: controller.getAgent },
    { method: 'put', path: '/agents/:agentId', handler: controller.updateAgent },
    { method: 'delete', path: '/agents/:agentId', handler: controller.deleteAgent },
    { method: 'get', path: '/agents/:agentId/tools', handler: controller.getAgentTools },
    { method: 'get', path: '/tools', handler: controller.getTools },
    { method: 'get', path: '/availability', handler: controller.availability },
    { method: 'get', path: '/settings', handler: controller.getSettings },
    { method: 'put', path: '/settings', handler: controller.updateSettings },
    // ⚠️ `/conversations/stats` e `/events` ANTES de qualquer `/conversations/:id`: senão seriam lidos como id.
    { method: 'get', path: '/conversations', handler: controller.listConversations },
    { method: 'get', path: '/conversations/stats', handler: controller.conversationStats },
    { method: 'get', path: '/conversations/events', handler: controller.conversationEvents },
    { method: 'get', path: '/conversations/:id/turns', handler: controller.getConversationTurns },
    { method: 'put', path: '/conversations/:id/share', handler: controller.shareConversation },
    { method: 'delete', path: '/conversations/:id', handler: controller.deleteConversation },
    { method: 'get', path: '/shared/:id', handler: controller.getSharedConversation },
    { method: 'post', path: '/sessions', handler: controller.createSession },
    { method: 'get', path: '/sessions', handler: controller.listSessions },
    { method: 'get', path: '/sessions/:id', handler: controller.getSession },
    { method: 'delete', path: '/sessions/:id', handler: controller.deleteSession },
    { method: 'post', path: '/sessions/:id/messages', handler: controller.sendMessage },
    { method: 'post', path: '/sessions/:id/cancel', handler: controller.cancelSession },
  ]
}

/**
 * A tela nova, compilada pelo Vite em `web/dist`. Do `dist/infra/http` (build) e do `src/infra/http`
 * (dev) a raiz do projeto fica três níveis acima. Ausente = não compilada.
 */
function resolveWebDir(): string | undefined {
  const candidates = [path.resolve(__dirname, '../../../web/dist'), path.resolve(process.cwd(), 'web/dist')]

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')))
}

/**
 * A tela antiga. Não passa pelo `tsc`, então fica em `src/` mesmo depois do build.
 * Resolver a partir do `__dirname` faz o gateway subir de qualquer diretório — antes, com
 * `process.cwd()`, iniciar de outra pasta servia 404 em vez da UI.
 */
function resolvePublicDir(): string {
  const candidates = [path.resolve(__dirname, 'public'), path.resolve(__dirname, '../../../src/infra/http/public'), path.resolve(process.cwd(), 'src/infra/http/public')]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[candidates.length - 1]
}
