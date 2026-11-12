import { IMcpServerInput, McpServersService } from '@application/McpServers.Service'
import { McpOAuth } from '@infra/mcp/Mcp.OAuth'
import type { IProjectCaller } from '@application/Projects.Service'
import { IMcpServerConfig, isLaunchedMcp, mcpServerKey, parseMcpServerKey } from '@domain/models/McpServer.Model'
import { installPackage, installStatus, moveInstall, removeInstall } from '@infra/mcp/Mcp.Install'
import { caller } from '@infra/mcp/Caller.Identity'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { Request, Response } from 'express'
import { z } from 'zod'
import { resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { administers, adminView, IAdminView, isConnectedProject, refuseConnected, requireProjectAdmin, requireProjectsAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'

export interface IMcpServersControllerDeps {
  service: McpServersService
  registry: McpRegistry
  proof?: ICallerProof
  /** Quem é membro de quê (a regra única dos projetos). Ausente = sem projetos: só o admin vê a lista. */
  projects?: { canUse(caller: IProjectCaller, projectId: string): boolean; exists?(projectId: string): boolean }
  /** O login OAuth de cada pessoa (`auth: oauth`). Ausente = os MCPs OAuth não conectam. */
  oauth?: McpOAuth
}

const transport = z.enum(['auto', 'http', 'sse'])
const auth = z.enum(['caller', 'header', 'none', 'oauth'])
const oauthSchema = z.object({ clientId: z.string().max(300), scopes: z.string().max(2000).optional(), authorizationServer: z.string().max(500).optional() })
const containerSchema = z.object({
  image: z.string().max(300).optional(),
  args: z.array(z.string().max(300)).max(32).optional(),
  writable: z.array(z.string().max(200)).max(8).optional(),
  memoryMb: z.number().optional(),
  cpus: z.number().optional(),
  network: z.enum(['none', 'allowlist']).optional(),
  allowedHosts: z.array(z.string().max(200)).max(50).optional(),
  env: z.array(z.string().max(64)).max(20).optional(),
})
const processSchema = z.object({
  package: z.string().max(300).optional(),
  command: z.string().max(300).optional(),
  args: z.array(z.string().max(300)).max(32).optional(),
  env: z.array(z.string().max(64)).max(20).optional(),
  scope: z.enum(['conversation', 'shared']).optional(),
})
const projectId = z.string().max(64)
const createSchema = z.object({
  id: z.string().max(64),
  projectId: projectId.optional(),
  name: z.string().max(200),
  /** As tags (ver `Tag.Policy`: o serviço normaliza e confere). */
  tags: z.array(z.string().max(80)).max(50).optional(),
  kind: z.enum(['remote', 'container', 'process']).optional(),
  container: containerSchema.optional(),
  process: processSchema.optional(),
  url: z.string().max(2000).optional(),
  transport: transport.optional(),
  auth: auth.optional(),
  headerName: z.string().max(64).optional(),
  identity: z.boolean().optional(),
  oauth: oauthSchema.optional(),
  secret: z.string().max(4000).optional(),
})
const updateSchema = z.object({
  /** Troca o escopo: um projeto, ou `null` para global. */
  projectId: projectId.nullable().optional(),
  name: z.string().max(200).optional(),
  /** Ausente = mantém; `[]` tira todas. */
  tags: z.array(z.string().max(80)).max(50).optional(),
  container: containerSchema.optional(),
  process: processSchema.optional(),
  url: z.string().max(2000).optional(),
  transport: transport.optional(),
  auth: auth.optional(),
  headerName: z.string().max(64).optional(),
  identity: z.boolean().optional(),
  oauth: oauthSchema.optional(),
  enabled: z.boolean().optional(),
})
const secretSchema = z.object({ secret: z.string().max(4000) })
const envSchema = z.object({ value: z.string().max(8000) })

/**
 * A guia MCPs: o cadastro dos servidores de onde os agentes tiram ferramentas.
 *
 * ⚖️ O `:id` DAS ROTAS É A CHAVE (`mcpServerKey`): `n8n` é o global; `cliente-a.n8n`, o do projeto `cliente-a`.
 *
 * ⛔ GERENCIAR É SÓ DO ADMINISTRADOR DO ESCOPO DO SERVIDOR (ver `Project.Access`): o de projeto, o admin dele; o global,
 * o do gateway. 404 para os demais (como `/providers`): a lista diz que serviços internos existem. A exceção é ver a lista de UM projeto (`?project=`): o
 * membro dele vê os MCPs daquele projeto (como vê os agentes dele) — nunca os globais, nunca os de outro projeto.
 * ⛔ O segredo nunca sai — só se está configurado e os quatro últimos caracteres.
 *
 * 🔌 NO PROJETO CONECTADO, o servidor que veio da origem é só leitura (409); o cadastrado AQUI nasce "desta máquina"
 * (`local`) e segue livre: é configuração do ambiente, que a atualização não toca e o catálogo não exporta.
 */
export class McpServersController {
  constructor(private readonly deps: IMcpServersControllerDeps) {
    for (const name of [
      'list',
      'create',
      'update',
      'remove',
      'saveSecret',
      'clearSecret',
      'test',
      'tools',
      'saveEnv',
      'stopInstances',
      'install',
      'oauthStart',
      'oauthDisconnect',
      'oauthCallback',
    ] as const)
      this[name] = this[name].bind(this)
  }

  /**
   * ⚖️ CONECTAR A PRÓPRIA CONTA num MCP com login OAuth: quem pode usar o servidor (o global, qualquer conta; o de
   * projeto, os membros dele) recebe o endereço do login. O token fica para ESTA pessoa (ver `McpOAuth`).
   */
  async oauthStart(req: Request, res: Response) {
    await this.respond(res, async () => {
      const { key, userId } = await this.oauthCaller(req)
      if (!this.deps.oauth) throw new HttpError(404, 'not_found', 'OAuth is not available')
      return { url: await this.deps.oauth.start(key, userId, redirectUri(req)) }
    })
  }

  /** Desconecta a conta de quem chama (o token sai do cofre; a conexão dela com o MCP fecha). */
  async oauthDisconnect(req: Request, res: Response) {
    await this.respond(res, async () => {
      const { key, userId } = await this.oauthCaller(req)
      this.deps.oauth?.disconnect(key, userId)
      this.deps.registry.forget(key, userId)
      return null
    })
  }

  /**
   * O retorno do login (rota PÚBLICA: quem chega é o navegador vindo do provedor). Troca o código e volta para a tela
   * do MCP. ⛔ Sem `state` válido, nada é gravado (ver `McpOAuth.finish`).
   */
  async oauthCallback(req: Request, res: Response) {
    const text = (value: unknown) => (typeof value === 'string' ? value : '')
    const state = text(req.query.state)
    const denied = text(req.query.error)
    try {
      if (denied || !state || !text(req.query.code)) throw new Error(denied ? `the provider refused: ${denied}` : 'missing code or state')
      const { serverKey } = await this.deps.oauth!.finish(state, text(req.query.code))
      this.deps.registry.forget(serverKey)
      res.redirect(302, `/mcp/${encodeURIComponent(serverKey)}?oauth=ok`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[mcp-oauth] o retorno do login falhou:', message)
      res.redirect(302, `/mcp?oauth=error&message=${encodeURIComponent(message.slice(0, 200))}`)
    }
  }

  /** Quem chama (com conta) e o servidor OAuth que ele pode usar; 404 para o resto. */
  private async oauthCaller(req: Request): Promise<{ key: string; userId: string }> {
    const key = this.idOf(req)
    const server = this.deps.service.list().find((item) => mcpServerKey(item) === key)
    const resolved = await resolveCaller(this.deps.proof)
    const userId = resolved?.identity?.id
    if (!server || server.auth !== 'oauth' || !userId) throw new HttpError(404, 'not_found', 'Not found')
    if (server.projectId && this.deps.projects && !this.deps.projects.canUse({ userId, admin: !!(await adminView(this.deps.proof))?.gateway }, server.projectId))
      throw new HttpError(404, 'not_found', 'Not found')
    return { key, userId }
  }

  /** Se a pessoa da tela já conectou a conta, e o endereço de retorno que o provedor precisa ter cadastrado. */
  private oauthStatus(server: IMcpServerConfig, req?: Request): { oauthConnected?: boolean; oauthRedirectUri?: string } {
    if (server.auth !== 'oauth') return {}
    const userId = caller()?.id
    return { oauthConnected: !!userId && !!this.deps.oauth?.connected(mcpServerKey(server), userId), ...(req ? { oauthRedirectUri: redirectUri(req) } : {}) }
  }

  /**
   * Admin: os globais e os dos projetos que administra; com `?project=` de um projeto dele, os globais e os daquele
   * projeto (o que um agente dele enxerga). Membro: só com `?project=` de um projeto dele, e só os daquele projeto, sem
   * o erro de conexão (pode trazer endereço interno). ⛔ O admin do gateway não vê o MCP de projeto de que não é admin.
   */
  async list(req: Request, res: Response) {
    await this.respond(res, async () => {
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      const view = await adminView(this.deps.proof)
      if (view && (!project || administers(view, project))) {
        if (project && this.deps.projects?.exists && !this.deps.projects.exists(project)) throw new HttpError(404, 'not_found', `Project not found: ${project}`)
        return this.deps.service
          .list()
          .filter((server) => (project ? !server.projectId || server.projectId === project : !server.projectId || administers(view, server.projectId)))
          .map((server) => this.toDto(server, true, view, req))
      }
      const resolved = project && this.deps.projects ? await resolveCaller(this.deps.proof) : undefined
      if (!project || !resolved || !this.deps.projects?.canUse({ userId: resolved.identity?.id, admin: false }, project)) {
        console.warn('[admin] acesso negado a listMcpServers:', 'not an administrator or a member of the project')
        throw new HttpError(404, 'not_found', 'Not found')
      }
      return (
        this.deps.service
          .list()
          // O global com login OAuth também: cada pessoa conecta a própria conta (sem ver como ele foi cadastrado).
          .filter((server) => server.projectId === project || (!server.projectId && server.auth === 'oauth'))
          .map((server) => this.toDto(server, false, undefined, req))
      )
    })
  }

  async create(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const body = parseBody(createSchema, req.body)
        const by = await this.requireScopes('createMcpServer', body.projectId ?? null, privileged({ kind: body.kind ?? 'remote', auth: body.auth }))
        const created = this.deps.service.create({ ...(body as IMcpServerInput), local: isConnectedProject(body.projectId) }, by)
        return this.dto(created)
      },
      { status: 201, message: 'MCP server created' },
    )
  }

  async update(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = this.idOf(req)
        const body = parseBody(updateSchema, req.body)
        // ⛔ Trocar o escopo (`projectId`) pede admin dos dois: o de onde sai e o de onde entra.
        const current = scopeOf(id)
        const before = this.deps.service.get(id)
        const by = await requireProjectsAdmin(
          this.deps.proof,
          [
            current,
            body.projectId === undefined ? current : body.projectId,
            ...(privileged(before) || privileged({ kind: before.kind, auth: body.auth ?? before.auth }) ? [null] : []),
          ],
          'updateMcpServer',
        )
        // ⛔ O que veio da origem não muda aqui, nem sai do projeto conectado.
        if (!before.local) refuseConnected(current)
        // Trocou de escopo: é "desta máquina" quem entra num projeto conectado, e deixa de ser quem sai dele.
        const moving = body.projectId !== undefined && (body.projectId ?? null) !== current
        const updated = this.deps.service.update(id, { ...body, ...(moving ? { local: isConnectedProject(body.projectId) } : {}) }, by)
        const key = mcpServerKey(updated)
        // Instância de pé roda o cadastro de antes: a próxima ferramenta sobe com o novo.
        if (isLaunchedMcp(updated) || key !== id) await this.deps.registry.closeInstances({ serverId: id })
        // ⛔ Mudou de escopo: o cliente da chave antiga sai (não fica conectado com a credencial de antes) e o pacote vai junto.
        if (key !== id) {
          this.deps.registry.forget(id)
          if (updated.kind === 'process') moveInstall(id, key)
        }
        return this.dto(updated)
      },
      { message: 'MCP server updated' },
    )
  }

  async remove(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = this.idOf(req)
        const by = await this.requireAdmin('deleteMcpServer', id)
        const { kind, local } = this.deps.service.get(id)
        if (!local) refuseConnected(scopeOf(id))
        this.deps.service.remove(id, by)
        this.deps.registry.forget(id)
        await this.deps.registry.closeInstances({ serverId: id })
        if (kind === 'process') removeInstall(id)
        return null
      },
      { message: 'MCP server deleted' },
    )
  }

  async saveSecret(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = this.idOf(req)
        const by = await this.requireAdmin('saveMcpSecret', id)
        this.deps.service.saveSecret(id, parseBody(secretSchema, req.body).secret, by)
        return this.dto(this.deps.service.get(id))
      },
      { message: 'Secret saved' },
    )
  }

  async clearSecret(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = this.idOf(req)
        await this.requireAdmin('clearMcpSecret', id)
        this.deps.service.clearSecret(id)
        return this.dto(this.deps.service.get(id))
      },
      { message: 'Secret removed' },
    )
  }

  /** O valor de uma variável secreta do contêiner. ⛔ Só entra; nunca volta. */
  async saveEnv(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = this.idOf(req)
        const by = await this.requireAdmin('saveMcpEnv', id, true)
        this.deps.service.saveEnv(id, req.params.name as string, parseBody(envSchema, req.body).value, by)
        return this.dto(this.deps.service.get(id))
      },
      { message: 'Variable saved' },
    )
  }

  /** Encerra as instâncias (conversas) de um contêiner — a próxima ferramenta sobe uma nova. */
  async stopInstances(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = this.idOf(req)
      await this.requireAdmin('stopMcpInstances', id)
      this.deps.service.get(id)
      return { stopped: await this.deps.registry.closeInstances({ serverId: id }) }
    })
  }

  /**
   * O botão Instalar de um MCP `process`: `npm install` do pacote do cadastro, ao lado do anterior (que fica
   * de pé se este falhar). As instâncias abertas morrem: a próxima ferramenta sobe com o pacote novo.
   */
  async install(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = this.idOf(req)
      await this.requireAdmin('installMcpServer', id, true)
      const server = this.deps.service.get(id)
      if (server.kind !== 'process' || !server.process?.package) throw new HttpError(422, 'validation_error', 'Only a local process MCP with an npm package can be installed')
      const result = await installPackage(id, server.process.package)
      if (result.ok) await this.deps.registry.closeInstances({ serverId: id })
      return { ok: result.ok, ...(result.version ? { version: result.version } : {}), log: result.log, server: await this.dto(this.deps.service.get(id)) }
    })
  }

  /** Conecta AGORA (ignorando o backoff) e lista as ferramentas — o botão "Testar conexão". */
  async test(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = this.idOf(req)
      await this.requireAdmin('testMcpServer', id)
      this.deps.service.get(id)
      // O teste conecta como quem está na tela: um MCP `caller` recusa a conexão anônima.
      const result = await this.deps.registry.test(id, caller()?.token)
      return { ok: result.ok, tools: result.tools.length, ...(result.message ? { message: result.message } : {}) }
    })
  }

  async tools(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = this.idOf(req)
      await this.requireAdmin('listMcpTools', id)
      this.deps.service.get(id)
      return (await this.deps.registry.probeTools(id, caller()?.token)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    })
  }

  /** O servidor para quem administra: o `toDto` com a visão da conta (os agentes de projetos que ela não administra não aparecem). */
  private async dto(server: IMcpServerConfig) {
    return this.toDto(server, true, await adminView(this.deps.proof))
  }

  /**
   * `full`: o admin vê o erro de conexão; o membro, não (a mensagem pode trazer endereço interno). `view`: ⛔ o global
   * é lido por qualquer admin, mas os agentes de OUTROS projetos que o usam só aparecem a quem os administra.
   */
  /**
   * ⛔ O MEMBRO (não administra o projeto) só vê QUE o MCP existe e se está de pé: nada de URL, cabeçalho, comando,
   * contêiner, variáveis, nem o fim do segredo — é a configuração de quem administra.
   */
  private memberDto(server: IMcpServerConfig, req?: Request) {
    const key = mcpServerKey(server)
    const status = this.deps.registry.status().find((entry) => entry.key === key)
    return {
      key,
      id: server.id,
      ...(server.projectId ? { projectId: server.projectId } : {}),
      name: server.name,
      ...(server.tags?.length ? { tags: server.tags } : {}),
      kind: server.kind ?? 'remote',
      ...(server.local ? { local: true } : {}),
      // ⛔ Como o servidor autentica não é do membro; só que ele pede a conta de cada um (o botão Conectar).
      ...(server.auth === 'oauth' ? { auth: server.auth } : {}),
      ...this.oauthStatus(server, req),
      enabled: server.enabled,
      // A mesma forma da tela (que lê `secret.configured` e `agents`), sem o que é de quem administra.
      secret: { configured: this.deps.service.secretStatus(key).configured },
      status: { connected: status?.connected ?? false },
      agents: [] as Array<{ id: string; name: string }>,
    }
  }

  private toDto(server: IMcpServerConfig, full = true, view?: IAdminView, req?: Request) {
    if (!full) return this.memberDto(server, req)
    const key = mcpServerKey(server)
    const secret = this.deps.service.secretStatus(key)
    const status = this.deps.registry.status().find((entry) => entry.key === key)
    return {
      key,
      id: server.id,
      ...(server.projectId ? { projectId: server.projectId } : {}),
      name: server.name,
      ...(server.tags?.length ? { tags: server.tags } : {}),
      kind: server.kind ?? 'remote',
      ...(server.container ? { container: server.container, env: this.deps.service.envStatus(key) } : {}),
      ...(server.process ? { process: server.process, env: this.deps.service.envStatus(key), install: installStatus(key, server.process.package) } : {}),
      url: server.url,
      transport: server.transport,
      auth: server.auth,
      headerName: server.headerName,
      identity: server.identity === true,
      ...(server.oauth ? { oauth: server.oauth } : {}),
      ...(server.local ? { local: true } : {}),
      ...this.oauthStatus(server, req),
      enabled: server.enabled,
      secret: {
        configured: secret.configured,
        ...(secret.last4 ? { last4: secret.last4 } : {}),
        ...(secret.unreadable ? { unreadable: true } : {}),
        updatedAt: secret.updatedAt,
        updatedBy: secret.updatedBy,
      },
      status: {
        connected: status?.connected ?? false,
        ...(full && status?.lastError ? { lastError: status.lastError } : {}),
        ...(status?.instances !== undefined ? { instances: status.instances } : {}),
      },
      agents: this.deps.service
        .usedBy(key)
        .filter((agent) => !view || administers(view, agent.projectId))
        .map((agent) => ({ id: agent.id, name: agent.name })),
      /** A URL é o MCP do próprio gateway: agente que conversa com agentes pode entrar em recursão. */
      selfReference: !isLaunchedMcp(server) && /\/v1\/mcp\/?$/.test(safePath(server.url)),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      updatedBy: server.updatedBy,
    }
  }

  /** A chave do servidor (`n8n`, `cliente-a.n8n`). */
  private idOf(req: Request): string {
    return req.params.id as string
  }

  /**
   * ⛔ O servidor é do escopo da chave: o admin do projeto dele (o global, o do gateway). `launch`: mexer no que roda no
   * host (o ambiente, o `npm install`) de um MCP privilegiado pede também o admin do gateway (ver `privileged`).
   */
  private requireAdmin(operation: string, id: string, launch = false): Promise<string> {
    return this.requireScopes(operation, scopeOf(id), launch && privileged(this.deps.service.get(id)))
  }

  private requireScopes(operation: string, projectId: string | null, gateway: boolean): Promise<string> {
    return gateway ? requireProjectsAdmin(this.deps.proof, [projectId, null], operation) : requireProjectAdmin(this.deps.proof, projectId, operation)
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[McpServersController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/**
 * O endereço de retorno do login OAuth: `PUBLIC_URL` (o endereço público do gateway), senão o da própria requisição
 * (atrás de um proxy confiável, o `X-Forwarded-*` dele). ⚠️ O provedor só aceita o que estiver cadastrado nele.
 */
export function redirectUri(req: Request): string {
  const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') || `${req.protocol}://${req.get('host') ?? 'localhost'}`
  return `${base}/v1/oauth/callback`
}

/** O escopo de uma chave (`cliente-a.n8n` = o projeto; `n8n` = global, `null`). */
function scopeOf(key: string): string | null {
  return parseMcpServerKey(key)?.projectId ?? null
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/**
 * ⛔ O MCP que só o admin do GATEWAY cadastra (além do admin do projeto): o que roda no host (`process`: comando do
 * servidor, fora do cerco; `container`: imagem e rede) e o que recebe a credencial de quem conversa (`auth: caller` —
 * a URL de quem cadastrou levaria o token de todo membro). O admin de projeto cadastra o remoto com segredo próprio.
 */
function privileged(server: { kind?: string; auth?: string }): boolean {
  return server.kind === 'process' || server.kind === 'container' || server.auth === 'caller'
}
