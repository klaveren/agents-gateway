import { AgentController } from './Agent.Controller'
import { AuthController } from './Auth.Controller'
import { ProvidersController } from './Providers.Controller'
import { UsageController } from './Usage.Controller'
import { McpServersController } from './McpServers.Controller'
import { McpProxyController } from './McpProxy.Controller'
import { randomBytes } from 'node:crypto'
import { McpServersService } from '@application/McpServers.Service'
import { ProvidersService } from '@application/Providers.Service'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteProviderRepository } from '@infra/persistence/Sqlite.ProviderRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import express, { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import { Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { toHttpFailure } from './Http.Error'
import { fail } from './Http.Response'
import { OPENAPI_DOCUMENT } from './Openapi.Schema'
import { identityFromToken, tokenFromHeader, withCaller } from '@infra/mcp/Caller.Identity'
import { handleSelfMcp, rejectSelfMcp } from './SelfMcp.Controller'
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
 * · `/auth/status`, `/auth/setup` e `/auth/login` são a porta de entrada: sem credencial ainda, por
 * definição. O setup só funciona com zero contas e pedido desta máquina; o login tem trava de força bruta.
 *
 * Rota pública nova entra aqui — e só aqui, de propósito.
 */
export const PUBLIC_PATHS: readonly string[] = ['/health', '/shared/:id', '/auth/status', '/auth/setup', '/auth/login']

export type TRouteMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface IRoute {
  method: TRouteMethod
  /** Caminho sem o prefixo de versão, no estilo do Express (`/sessions/:id`). */
  path: string
  handler: RequestHandler
}

export class HttpServer {
  public readonly app: Express
  private readonly routes: IRoute[]

  constructor(
    private readonly controller: AgentController,
    private readonly auth: AuthController = new AuthController({}),
    providers: ProvidersController = defaultProvidersController(),
    usage?: UsageController,
    mcpServers: McpServersController = defaultMcpServersController(),
    mcpProxy?: McpProxyController,
  ) {
    this.app = express()
    this.app.disable('x-powered-by')
    this.app.use(corsMiddleware())
    this.app.use(express.json({ limit: jsonLimit() }))

    this.routes = buildRoutes(
      controller,
      auth,
      providers,
      usage ?? new UsageController({ conversations: controller.conversations }),
      mcpServers,
      mcpProxy ??
        new McpProxyController({ registry: new McpRegistry(new SqliteMcpServerRepository(), { get: () => undefined }), session: () => undefined, agentTools: () => undefined }),
    )
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
      // ⚠️ `no-cache` no index: é ele que aponta o bundle (com hash no nome). Em cache, o navegador seguia
      // abrindo a tela ANTIGA depois de cada deploy, até alguém forçar o recarregamento.
      res.setHeader('Cache-Control', 'no-cache')
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
    // O token de acesso vira sessão ANTES de tudo que lê a credencial (ver `AuthController.accessTokenGate`).
    const exchange = this.auth.accessTokenGate

    // O contrato também é fechado: entrega o mapa de todas as rotas, e presença de header não é
    // identidade — então passa pelo mesmo portão e pela mesma resolução do chamador.
    this.app.get(`${API_PREFIX}/openapi.json`, guard, exchange, identity, callerScope, this.controller.guardCaller, (_req, res) => {
      res.json(OPENAPI_DOCUMENT)
    })

    for (const { method, path: routePath, handler } of this.routes) {
      const chain = PUBLIC_PATHS.includes(routePath) ? [guard, exchange, callerScope, handler] : [guard, exchange, identity, callerScope, handler]
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

function buildRoutes(
  controller: AgentController,
  auth: AuthController,
  providers: ProvidersController,
  usage: UsageController,
  mcpServers: McpServersController,
  mcpProxy: McpProxyController,
): IRoute[] {
  return [
    // A ponte dos SDKs agênticos até os MCPs em contêiner (ver `McpProxy.Controller`).
    { method: 'post', path: '/mcp-proxy/:serverId', handler: mcpProxy.handle },
    { method: 'get', path: '/mcp-servers', handler: mcpServers.list },
    { method: 'post', path: '/mcp-servers', handler: mcpServers.create },
    { method: 'put', path: '/mcp-servers/:id', handler: mcpServers.update },
    { method: 'delete', path: '/mcp-servers/:id', handler: mcpServers.remove },
    { method: 'put', path: '/mcp-servers/:id/secret', handler: mcpServers.saveSecret },
    { method: 'delete', path: '/mcp-servers/:id/secret', handler: mcpServers.clearSecret },
    { method: 'post', path: '/mcp-servers/:id/test', handler: mcpServers.test },
    { method: 'get', path: '/mcp-servers/:id/tools', handler: mcpServers.tools },
    { method: 'put', path: '/mcp-servers/:id/env/:name', handler: mcpServers.saveEnv },
    { method: 'post', path: '/mcp-servers/:id/stop', handler: mcpServers.stopInstances },
    // O gateway como servidor MCP (ver `SelfMcp.Controller`): só POST; sem estado, GET e DELETE são 405.
    { method: 'post', path: '/mcp', handler: handleSelfMcp },
    { method: 'get', path: '/mcp', handler: rejectSelfMcp },
    { method: 'delete', path: '/mcp', handler: rejectSelfMcp },
    { method: 'get', path: '/usage/me', handler: usage.mine },
    { method: 'get', path: '/usage/users', handler: usage.users },
    { method: 'get', path: '/usage/users/:ownerId', handler: usage.user },
    { method: 'get', path: '/usage/by/:key', handler: usage.byKey },
    { method: 'get', path: '/usage/by/:key/:value', handler: usage.byKeyValue },
    { method: 'get', path: '/providers', handler: providers.list },
    { method: 'post', path: '/providers', handler: providers.create },
    { method: 'put', path: '/providers/:id', handler: providers.update },
    { method: 'delete', path: '/providers/:id', handler: providers.remove },
    { method: 'put', path: '/providers/:id/key', handler: providers.saveKey },
    { method: 'delete', path: '/providers/:id/key', handler: providers.clearKey },
    { method: 'post', path: '/providers/:id/test', handler: providers.test },
    { method: 'get', path: '/providers/:id/models', handler: providers.listModels },
    { method: 'post', path: '/providers/:id/models/sync', handler: providers.syncModels },
    { method: 'put', path: '/providers/:id/models', handler: providers.updateModel },
    { method: 'get', path: '/health', handler: controller.health },
    { method: 'get', path: '/auth/status', handler: auth.status },
    { method: 'post', path: '/auth/setup', handler: auth.setup },
    { method: 'post', path: '/auth/login', handler: auth.login },
    { method: 'post', path: '/auth/logout', handler: auth.logout },
    { method: 'get', path: '/auth/me', handler: auth.me },
    { method: 'put', path: '/auth/password', handler: auth.changePassword },
    { method: 'get', path: '/auth/tokens', handler: auth.listTokens },
    { method: 'post', path: '/auth/tokens', handler: auth.createToken },
    { method: 'delete', path: '/auth/tokens/:id', handler: auth.revokeToken },
    { method: 'get', path: '/users', handler: auth.listUsers },
    { method: 'post', path: '/users', handler: auth.createUser },
    { method: 'put', path: '/users/:id', handler: auth.updateUser },
    { method: 'post', path: '/users/:id/password', handler: auth.resetPassword },
    { method: 'delete', path: '/users/:id/sessions', handler: auth.revokeSessions },
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
    { method: 'patch', path: '/sessions/:id', handler: controller.reconfigureSession },
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

/** Sem providers injetado: tudo em memória, sobre o ambiente — o teste e quem monta à mão. */
/** Sem composição (testes que sobem só o servidor): cadastro em memória, vazio. */
function defaultMcpServersController(): McpServersController {
  const credentials = new SqliteCredentialStore(new SecretBox(randomBytes(32)))
  const servers = new SqliteMcpServerRepository()
  return new McpServersController({ service: new McpServersService(servers, credentials, () => []), registry: new McpRegistry(servers, credentials) })
}

function defaultProvidersController(): ProvidersController {
  const credentials = new SqliteCredentialStore(new SecretBox(randomBytes(32)))
  return new ProvidersController({ providers: new ProvidersService(new SqliteProviderRepository(), credentials), credentials, agents: { list: () => [], get: () => undefined } })
}
