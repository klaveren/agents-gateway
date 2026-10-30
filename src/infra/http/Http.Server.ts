import { PermissionsService } from '@application/Permissions.Service'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { ProjectAccountsService } from '@application/ProjectAccounts.Service'
import { SqliteProjectAccountRepository } from '@infra/persistence/Sqlite.ProjectAccountRepository'
import { PermissionsController } from './Permissions.Controller'
import { ProjectAccountsController } from './ProjectAccounts.Controller'
import { SecretMaskController } from './SecretMask.Controller'
import { SecretMasker } from '@infra/secrets/Secret.Masker'
import { SchedulesController } from './Schedules.Controller'
import { AgentSchedulesService } from '@application/AgentSchedules.Service'
import { ScheduleRunner } from '@application/Schedule.Runner'
import { SqliteAgentScheduleRepository } from '@infra/persistence/Sqlite.AgentScheduleRepository'
import { cookieCredential } from './Session.Cookie'
import { AgentController } from './Agent.Controller'
import { AuthController } from './Auth.Controller'
import { ProvidersController } from './Providers.Controller'
import { UsageController } from './Usage.Controller'
import { McpServersController } from './McpServers.Controller'
import { McpProxyController } from './McpProxy.Controller'
import { TurnToolsController } from './TurnTools.Controller'
import { PackagesController } from './Packages.Controller'
import { HOOK_PATH, HooksController } from './Hooks.Controller'
import { ProjectsController } from './Projects.Controller'
import { ImportController } from './Import.Controller'
import { CatalogController } from './Catalog.Controller'
import { CatalogHistoryQuery } from '@application/CatalogHistory.Query'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { GuidanceController } from './Guidance.Controller'
import { GuidanceService } from '@application/Guidance.Service'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { ProjectsService } from '@application/Projects.Service'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
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
import { CALLER_HEADER, corsMiddleware, host, jsonLimit, requireCaller, messageJsonLimit, rateLimit, securityHeaders, trustProxySetting } from './Security.Middleware'

export const API_PREFIX = '/v1'

/**
 * As ÚNICAS rotas que respondem sem credencial de quem chama.
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
/** A mensagem de uma conversa: leva anexo, por isso o teto de corpo grande. */
const MESSAGE_ROUTE = /^\/v1\/sessions\/[^/]+\/messages\/?$/
/**
 * ⚖️ As rotas que gravam CONTEÚDO, cujo tamanho é de quem escreve (o sistema não impõe teto): o agente (prompt, soul,
 * triggers), os hooks e agendamentos dele (o prompt), rules, documentos, skills/commands e o complemento dos protocolos.
 * Também o MCP próprio (as mesmas gravações, como ferramenta) e o `turn-tools` (o rascunho do construtor num CLI).
 */
const CONTENT_ROUTES: readonly RegExp[] = [
  /^\/v1\/agents(?:\/[^/]+)?\/?$/,
  /^\/v1\/agents\/[^/]+\/(?:hooks|schedules)(?:\/[^/]+)?\/?$/,
  /^\/v1\/(?:rules|docs|resources)(?:\/[^/]+)?\/?$/,
  /^\/v1\/protocols\/[^/]+\/addendum\/?$/,
  /^\/v1\/(?:mcp|turn-tools)\/?$/,
]
const HOOK_ROUTE = /^\/v1\/hook\/[^/]+\/[^/]+\/?$/
/** As rotas com limite por origem (ver `rateLimit`). */
export const THROTTLED_PATHS = ['/auth/login', '/auth/setup']

/** ⚠️ O hook é público: a credencial dele é a chave do hook (ver `Hooks.Controller`), não uma conta. */
export const PUBLIC_PATHS: readonly string[] = ['/health', '/shared/:id', '/auth/status', '/auth/setup', '/auth/login', HOOK_PATH]

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
    packages: PackagesController = new PackagesController(),
    hooks?: HooksController,
    projects?: ProjectsController,
    guidance?: GuidanceController,
    schedules?: SchedulesController,
    permissions?: PermissionsController,
    accounts?: ProjectAccountsController,
    secretMask?: SecretMaskController,
    importer?: ImportController,
    catalog?: CatalogController,
  ) {
    this.app = express()
    this.app.disable('x-powered-by')
    // Atrás de um proxy listado em `TRUST_PROXY`, `req.ip` e `req.secure` vêm do `X-Forwarded-*` dele.
    const trusted = trustProxySetting()
    if (trusted) this.app.set('trust proxy', trusted)
    this.app.use(securityHeaders())
    this.app.use(corsMiddleware())
    // ⛔ Dois tetos: o pequeno vale para tudo (o corpo é lido ANTES da autenticação); o grande, só para a
    // mensagem de uma conversa, que leva anexo, e para as rotas que gravam conteúdo (`CONTENT_ROUTES`).
    const small = express.json({ limit: jsonLimit() })
    const large = express.json({ limit: messageJsonLimit() })
    // ⚖️ O hook lê o corpo CRU: a assinatura HMAC é dos bytes exatos, e o serviço que chama manda o que quiser.
    const raw = express.raw({ type: () => true, limit: '256kb' })
    this.app.use((req, res, next) =>
      HOOK_ROUTE.test(req.path)
        ? raw(req, res, next)
        : MESSAGE_ROUTE.test(req.path) || CONTENT_ROUTES.some((route) => route.test(req.path))
          ? large(req, res, next)
          : small(req, res, next),
    )
    // A sessão da tela chega no cookie HttpOnly; daqui em diante é a mesma credencial do cabeçalho.
    this.app.use(cookieCredential())

    this.routes = buildRoutes(
      controller,
      auth,
      providers,
      usage ?? new UsageController({ conversations: controller.conversations }),
      mcpServers,
      mcpProxy ??
        new McpProxyController({ registry: new McpRegistry(new SqliteMcpServerRepository(), { get: () => undefined }), session: () => undefined, agent: () => undefined }),
      packages,
      hooks ?? new HooksController({ hooks: defaultHooks(), sessionFor: () => undefined }),
      projects ?? new ProjectsController({ projects: defaultProjects() }),
      guidance ?? new GuidanceController({ guidance: new GuidanceService(new SqliteGuidanceRepository(), () => false) }),
      schedules ?? defaultSchedules(),
      permissions ?? defaultPermissions(),
      accounts ?? defaultAccounts(),
      secretMask ?? new SecretMaskController({ masker: new SecretMasker(new SecretBox(randomBytes(32))) }),
      importer ?? defaultImporter(),
      catalog ?? defaultCatalog(),
    )
    this.setupRoutes()
    this.setupFrontend()
  }

  /**
   * A tela (Vue, `web/dist`) na raiz.
   *
   * ⚖️ DEPOIS DA API, de propósito: o fallback do SPA devolve `index.html` para qualquer GET que
   * peça HTML, e registrado antes ele responderia no lugar de uma rota da API. Rota desconhecida em
   * `/v1` continua sendo da API (404 dela), nunca a tela.
   *
   * Sem `web/dist` (o front não foi compilado), sobe só a API.
   */
  private setupFrontend() {
    const web = resolveWebDir()
    if (!web) return

    this.app.use(express.static(web, { index: false }))
    this.app.get(/^(?!\/v1(\/|$)).*/, (req, res, next) => {
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
     * ⚖️ HEADER PRÓPRIO (`X-Tool-Authorization`), e não o `Authorization`: é a credencial que o gateway
     * REPASSA às ferramentas, e um proxy na frente que mexa no `Authorization` não a toca. Na tela, vem do
     * cookie HttpOnly (ver `Session.Cookie`).
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

    const identity = requireCaller()
    // O token de acesso vira sessão ANTES de tudo que lê a credencial (ver `AuthController.accessTokenGate`).
    const exchange = this.auth.accessTokenGate

    // O contrato também é fechado: entrega o mapa de todas as rotas, e presença de header não é
    // identidade — então passa pelo mesmo portão e pela mesma resolução do chamador.
    this.app.get(`${API_PREFIX}/openapi.json`, exchange, identity, callerScope, this.controller.guardCaller, (_req, res) => {
      res.json(OPENAPI_DOCUMENT)
    })

    // ⛔ Login e setup: 20 por minuto por origem. A trava por e-mail não segura quem troca de e-mail.
    const throttled = rateLimit({ windowMs: 60_000, max: Number(process.env.AUTH_RATE_LIMIT) || 20 })
    // ⛔ Hook: 60 por minuto POR HOOK (`HOOK_RATE_LIMIT`) — cada chamada é um turno de modelo, e a URL é pública.
    const hookThrottle = rateLimit({ windowMs: 60_000, max: Number(process.env.HOOK_RATE_LIMIT) || 60, key: (req) => `${req.params.agentId}/${req.params.hookName}` })
    for (const { method, path: routePath, handler } of this.routes) {
      const open = PUBLIC_PATHS.includes(routePath) ? [exchange, callerScope, handler] : [exchange, identity, callerScope, handler]
      const chain = THROTTLED_PATHS.includes(routePath) ? [throttled, ...open] : routePath === HOOK_PATH ? [hookThrottle, ...open] : open
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

/** As ferramentas do gateway para os CLIs, pela concessão do turno (ver `Turn.Grants`). */
const turnTools = new TurnToolsController()

function buildRoutes(
  controller: AgentController,
  auth: AuthController,
  providers: ProvidersController,
  usage: UsageController,
  mcpServers: McpServersController,
  mcpProxy: McpProxyController,
  packages: PackagesController,
  hooks: HooksController,
  projects: ProjectsController,
  guidance: GuidanceController,
  schedules: SchedulesController,
  permissions: PermissionsController,
  accounts: ProjectAccountsController,
  secretMask: SecretMaskController,
  importer: ImportController,
  catalog: CatalogController,
): IRoute[] {
  return [
    // O histórico do catálogo (só leitura). O item vai na query: o id do complemento de protocolo tem barra.
    { method: 'get', path: '/catalog/history', handler: catalog.history },
    { method: 'get', path: '/catalog/history/diff', handler: catalog.diff },
    { method: 'get', path: '/catalog/history/revisions/:revision', handler: catalog.revision },
    // O rollback (só admin): restaurar uma revisão (o item vai no corpo, como na query acima) e reverter um lote.
    { method: 'post', path: '/catalog/history/restore', handler: catalog.restore },
    { method: 'post', path: '/catalog/batches/:batchId/revert', handler: catalog.revertBatch },
    { method: 'get', path: '/secret-mask', handler: secretMask.get },
    { method: 'put', path: '/secret-mask/values/:id', handler: secretMask.saveValue },
    { method: 'delete', path: '/secret-mask/values/:id', handler: secretMask.removeValue },
    { method: 'put', path: '/secret-mask/names', handler: secretMask.saveNames },
    { method: 'post', path: '/secret-mask/test', handler: secretMask.test },
    { method: 'get', path: '/projects/:projectId/accounts', handler: accounts.list },
    { method: 'put', path: '/projects/:projectId/accounts/:accountId', handler: accounts.save },
    { method: 'delete', path: '/projects/:projectId/accounts/:accountId', handler: accounts.remove },
    { method: 'post', path: '/projects/:projectId/accounts/:accountId/test', handler: accounts.test },
    { method: 'get', path: '/projects/:projectId/permissions', handler: permissions.get },
    { method: 'put', path: '/projects/:projectId/permissions', handler: permissions.save },
    { method: 'post', path: '/projects/:projectId/permissions/test', handler: permissions.test },
    { method: 'get', path: '/projects/:projectId/permissions/decisions', handler: permissions.decisions },
    { method: 'get', path: '/rules', handler: guidance.listRules },
    { method: 'post', path: '/rules', handler: guidance.createRule },
    { method: 'put', path: '/rules/:id', handler: guidance.updateRule },
    { method: 'delete', path: '/rules/:id', handler: guidance.deleteRule },
    { method: 'post', path: '/rules/:id/move', handler: guidance.moveRule },
    { method: 'get', path: '/docs', handler: guidance.listDocs },
    { method: 'post', path: '/docs', handler: guidance.createDoc },
    { method: 'get', path: '/docs/:id', handler: guidance.getDoc },
    { method: 'put', path: '/docs/:id', handler: guidance.updateDoc },
    { method: 'delete', path: '/docs/:id', handler: guidance.deleteDoc },
    { method: 'get', path: '/projects/:id/initial-context', handler: guidance.getInitialContext },
    { method: 'put', path: '/projects/:id/initial-context', handler: guidance.setInitialContext },
    { method: 'get', path: '/resources', handler: guidance.listResources },
    { method: 'post', path: '/resources', handler: guidance.createResource },
    { method: 'get', path: '/resources/:id', handler: guidance.getResource },
    { method: 'put', path: '/resources/:id', handler: guidance.updateResource },
    { method: 'delete', path: '/resources/:id', handler: guidance.deleteResource },
    { method: 'get', path: '/agents/:agentId/resources', handler: guidance.getAgentResources },
    { method: 'put', path: '/agents/:agentId/resources', handler: guidance.setAgentResources },
    { method: 'get', path: '/protocols/:kind', handler: guidance.getProtocol },
    { method: 'put', path: '/protocols/:kind/addendum', handler: guidance.setProtocolAddendum },
    { method: 'get', path: '/agents/:agentId/initial-context', handler: guidance.getAgentContext },
    { method: 'put', path: '/agents/:agentId/initial-context', handler: guidance.setAgentContext },
    { method: 'get', path: '/projects', handler: projects.list },
    { method: 'post', path: '/projects', handler: projects.create },
    { method: 'put', path: '/projects/:id', handler: projects.update },
    { method: 'delete', path: '/projects/:id', handler: projects.remove },
    { method: 'get', path: '/projects/:id/members', handler: projects.members },
    { method: 'get', path: '/projects/:id/repositories', handler: projects.repositories },
    { method: 'post', path: '/projects/:id/import/scan', handler: importer.scan },
    { method: 'post', path: '/projects/:id/import/plan', handler: importer.plan },
    { method: 'get', path: '/projects/:id/import/ignore', handler: importer.getIgnore },
    { method: 'put', path: '/projects/:id/import/ignore', handler: importer.setIgnore },
    { method: 'put', path: '/projects/:id/members', handler: projects.setMembers },
    { method: 'post', path: HOOK_PATH, handler: hooks.receive },
    { method: 'get', path: '/agents/:agentId/hooks', handler: hooks.list },
    { method: 'post', path: '/agents/:agentId/hooks', handler: hooks.create },
    { method: 'put', path: '/agents/:agentId/hooks/:hookName', handler: hooks.update },
    { method: 'delete', path: '/agents/:agentId/hooks/:hookName', handler: hooks.remove },
    { method: 'post', path: '/agents/:agentId/hooks/:hookName/rotate', handler: hooks.rotate },
    { method: 'get', path: '/agents/:agentId/hooks/:hookName/deliveries', handler: hooks.deliveries },
    { method: 'get', path: '/schedules', handler: schedules.listAll },
    { method: 'get', path: '/agents/:agentId/schedules', handler: schedules.list },
    { method: 'post', path: '/agents/:agentId/schedules', handler: schedules.create },
    { method: 'put', path: '/agents/:agentId/schedules/:scheduleName', handler: schedules.update },
    { method: 'delete', path: '/agents/:agentId/schedules/:scheduleName', handler: schedules.remove },
    { method: 'post', path: '/agents/:agentId/schedules/:scheduleName/run', handler: schedules.run },
    { method: 'get', path: '/agents/:agentId/schedules/:scheduleName/runs', handler: schedules.runs },
    { method: 'get', path: '/packages', handler: packages.list },
    { method: 'get', path: '/packages/search', handler: packages.search },
    { method: 'post', path: '/packages', handler: packages.install },
    { method: 'delete', path: '/packages/:name', handler: packages.remove },
    // A ponte dos SDKs agênticos até os MCPs em contêiner (ver `McpProxy.Controller`).
    { method: 'post', path: '/mcp-proxy/:serverId', handler: mcpProxy.handle },
    { method: 'post', path: '/turn-tools', handler: turnTools.handle },
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
    { method: 'post', path: '/mcp-servers/:id/install', handler: mcpServers.install },
    // O gateway como servidor MCP (ver `SelfMcp.Controller`): só POST; sem estado, GET e DELETE são 405.
    { method: 'post', path: '/mcp', handler: handleSelfMcp },
    { method: 'get', path: '/mcp', handler: rejectSelfMcp },
    { method: 'delete', path: '/mcp', handler: rejectSelfMcp },
    { method: 'get', path: '/usage/me', handler: usage.mine },
    { method: 'get', path: '/usage/users', handler: usage.users },
    { method: 'get', path: '/usage/users/:ownerId', handler: usage.user },
    { method: 'get', path: '/usage/by/:key', handler: usage.byKey },
    { method: 'get', path: '/usage/by/:key/:value', handler: usage.byKeyValue },
    { method: 'get', path: '/protocols', handler: providers.protocols },
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
    { method: 'post', path: '/providers/:id/models', handler: providers.addModel },
    { method: 'get', path: '/providers/:id/login', handler: providers.loginStatus },
    { method: 'post', path: '/providers/:id/login', handler: providers.loginStart },
    { method: 'post', path: '/providers/:id/login/code', handler: providers.loginCode },
    { method: 'delete', path: '/providers/:id/login', handler: providers.loginCancel },
    { method: 'get', path: '/health', handler: controller.health },
    { method: 'get', path: '/auth/status', handler: auth.status },
    { method: 'post', path: '/auth/setup', handler: auth.setup },
    { method: 'post', path: '/auth/login', handler: auth.login },
    { method: 'post', path: '/auth/logout', handler: auth.logout },
    { method: 'get', path: '/auth/me', handler: auth.me },
    { method: 'post', path: '/auth/cookie', handler: auth.sessionCookie },
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
    { method: 'get', path: '/agents/:agentId/footprint', handler: controller.getAgentFootprint },
    { method: 'get', path: '/agents/:agentId/commands', handler: controller.getAgentCommands },
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
    { method: 'put', path: '/conversations/events/:streamId/follow', handler: controller.followTurn },
    { method: 'get', path: '/conversations/:id/turns', handler: controller.getConversationTurns },
    { method: 'get', path: '/conversations/:id/todos', handler: controller.getConversationTodos },
    { method: 'put', path: '/conversations/:id/share', handler: controller.shareConversation },
    { method: 'delete', path: '/conversations/:id', handler: controller.deleteConversation },
    { method: 'get', path: '/shared/:id', handler: controller.getSharedConversation },
    { method: 'post', path: '/sessions', handler: controller.createSession },
    { method: 'get', path: '/sessions', handler: controller.listSessions },
    { method: 'get', path: '/sessions/:id', handler: controller.getSession },
    { method: 'delete', path: '/sessions/:id', handler: controller.deleteSession },
    { method: 'patch', path: '/sessions/:id', handler: controller.reconfigureSession },
    { method: 'post', path: '/sessions/:id/compact', handler: controller.compactSession },
    { method: 'post', path: '/sessions/:id/messages', handler: controller.sendMessage },
    { method: 'post', path: '/sessions/:id/turns', handler: controller.startTurn },
    { method: 'get', path: '/sessions/:id/turns/:turn', handler: controller.turnStatus },
    { method: 'get', path: '/sessions/:id/changes', handler: controller.changes },
    { method: 'get', path: '/sessions/:id/live', handler: controller.sessionLive },
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

/** Sem composição: agendamentos em memória, sem agentes, e um relógio que nunca liga. */
function defaultSchedules(): SchedulesController {
  const schedules = new AgentSchedulesService(
    new SqliteAgentScheduleRepository(),
    () => undefined,
    () => false,
  )
  return new SchedulesController({ schedules, runner: new ScheduleRunner(schedules, async () => ({})), agentProject: () => undefined })
}

/** Sem composição: contas em memória, sem projetos. */
function defaultAccounts(): ProjectAccountsController {
  const none = async () => Promise.reject(new Error('sem rede de contas aqui'))
  const tokens = { githubApp: none, describeGitHub: none, gcp: none, describeGcp: none }
  return new ProjectAccountsController({
    accounts: new ProjectAccountsService(new SqliteProjectAccountRepository(new SecretBox(randomBytes(32))), tokens),
    projectExists: () => false,
  })
}

/** Sem composição: permissões em memória, sem projetos. */
function defaultPermissions(): PermissionsController {
  return new PermissionsController({
    permissions: new PermissionsService(new SqlitePermissionRepository(), () => undefined),
    projectExists: () => false,
    agentExists: () => false,
    installationRules: () => [],
  })
}

/** Sem composição (testes que sobem só o servidor): hooks em memória, sem agentes. */
function defaultHooks(): AgentHooksService {
  return new AgentHooksService(new SqliteAgentHookRepository(), new SqliteCredentialStore(new SecretBox(randomBytes(32))), () => false)
}

/** Sem composição: projetos em memória, sem agentes nem contas, e a pasta só no nome. */
/** Sem composição: histórico vazio em memória, nenhum item existe agora, sem projetos (só o admin lê). */
function defaultCatalog(): CatalogController {
  return new CatalogController({ history: new CatalogHistoryQuery(new SqliteCatalogHistoryRepository(), { read: () => undefined }) })
}

/** Sem a fiação do composition root (os testes): nenhum projeto existe, então a varredura responde 404. */
function defaultImporter(): ImportController {
  return new ImportController({
    scan: new ImportScanUseCase({
      readTree: () => {
        throw new Error('importador sem fiação')
      },
      detectors: [],
      findInCatalog: () => undefined,
    }),
    projectExists: () => false,
  })
}

function defaultProjects(): ProjectsService {
  return new ProjectsService(
    new SqliteProjectRepository(),
    () => [],
    () => false,
    { create: (id) => id, remove: () => undefined },
  )
}
