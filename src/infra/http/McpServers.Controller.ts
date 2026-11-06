import { IMcpServerInput, McpServersService } from '@application/McpServers.Service'
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
import { administers, adminView, IAdminView, requireProjectAdmin, requireProjectsAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'

export interface IMcpServersControllerDeps {
  service: McpServersService
  registry: McpRegistry
  proof?: ICallerProof
  /** Quem é membro de quê (a regra única dos projetos). Ausente = sem projetos: só o admin vê a lista. */
  projects?: { canUse(caller: IProjectCaller, projectId: string): boolean; exists?(projectId: string): boolean }
}

const transport = z.enum(['auto', 'http', 'sse'])
const auth = z.enum(['caller', 'header', 'none'])
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
 */
export class McpServersController {
  constructor(private readonly deps: IMcpServersControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'saveSecret', 'clearSecret', 'test', 'tools', 'saveEnv', 'stopInstances', 'install'] as const)
      this[name] = this[name].bind(this)
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
          .map((server) => this.toDto(server, true, view))
      }
      const resolved = project && this.deps.projects ? await resolveCaller(this.deps.proof) : undefined
      if (!project || !resolved || !this.deps.projects?.canUse({ userId: resolved.identity?.id, admin: false }, project)) {
        console.warn('[admin] acesso negado a listMcpServers:', 'not an administrator or a member of the project')
        throw new HttpError(404, 'not_found', 'Not found')
      }
      return this.deps.service
        .list()
        .filter((server) => server.projectId === project)
        .map((server) => this.toDto(server, false))
    })
  }

  async create(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const body = parseBody(createSchema, req.body)
        const by = await requireProjectAdmin(this.deps.proof, body.projectId, 'createMcpServer')
        const created = this.deps.service.create(body as IMcpServerInput, by)
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
        const by = await requireProjectsAdmin(this.deps.proof, [current, body.projectId === undefined ? current : body.projectId], 'updateMcpServer')
        const updated = this.deps.service.update(id, body, by)
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
        const kind = this.deps.service.get(id).kind
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
        const by = await this.requireAdmin('saveMcpEnv', id)
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
      await this.requireAdmin('installMcpServer', id)
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
  private toDto(server: IMcpServerConfig, full = true, view?: IAdminView) {
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

  /** ⛔ O servidor é do escopo da chave: o admin do projeto dele (o global, o do gateway). */
  private requireAdmin(operation: string, id: string): Promise<string> {
    return requireProjectAdmin(this.deps.proof, scopeOf(id), operation)
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
