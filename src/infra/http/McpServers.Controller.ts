import { IMcpServerInput, McpServersService } from '@application/McpServers.Service'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { Request, Response } from 'express'
import { z } from 'zod'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IMcpServersControllerDeps {
  service: McpServersService
  registry: McpRegistry
  proof?: ICallerProof
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
const createSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(200),
  kind: z.enum(['remote', 'container']).optional(),
  container: containerSchema.optional(),
  url: z.string().max(2000).optional(),
  transport: transport.optional(),
  auth: auth.optional(),
  headerName: z.string().max(64).optional(),
  secret: z.string().max(4000).optional(),
})
const updateSchema = z.object({
  name: z.string().max(200).optional(),
  container: containerSchema.optional(),
  url: z.string().max(2000).optional(),
  transport: transport.optional(),
  auth: auth.optional(),
  headerName: z.string().max(64).optional(),
  enabled: z.boolean().optional(),
})
const secretSchema = z.object({ secret: z.string().max(4000) })
const envSchema = z.object({ value: z.string().max(8000) })

/**
 * A guia MCPs: o cadastro dos servidores de onde os agentes tiram ferramentas.
 *
 * ⛔ SÓ ADMINISTRADOR, e 404 para os demais (como `/providers`): a lista diz que serviços internos existem.
 * ⛔ O segredo nunca sai — só se está configurado e os quatro últimos caracteres.
 */
export class McpServersController {
  constructor(private readonly deps: IMcpServersControllerDeps) {
    for (const name of ['list', 'create', 'update', 'remove', 'saveSecret', 'clearSecret', 'test', 'tools', 'saveEnv', 'stopInstances'] as const) this[name] = this[name].bind(this)
  }

  async list(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listMcpServers')
      return this.deps.service.list().map((server) => this.toDto(server))
    })
  }

  async create(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('createMcpServer')
        const created = this.deps.service.create(parseBody(createSchema, req.body) as IMcpServerInput, by)
        return this.toDto(created)
      },
      { status: 201, message: 'MCP server created' },
    )
  }

  async update(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('updateMcpServer')
        const updated = this.deps.service.update(this.idOf(req), parseBody(updateSchema, req.body), by)
        return this.toDto(updated)
      },
      { message: 'MCP server updated' },
    )
  }

  async remove(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('deleteMcpServer')
        const id = this.idOf(req)
        this.deps.service.remove(id)
        this.deps.registry.forget(id)
        return null
      },
      { message: 'MCP server deleted' },
    )
  }

  async saveSecret(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('saveMcpSecret')
        const id = this.idOf(req)
        this.deps.service.saveSecret(id, parseBody(secretSchema, req.body).secret, by)
        return this.toDto(this.deps.service.get(id))
      },
      { message: 'Secret saved' },
    )
  }

  async clearSecret(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('clearMcpSecret')
        const id = this.idOf(req)
        this.deps.service.clearSecret(id)
        return this.toDto(this.deps.service.get(id))
      },
      { message: 'Secret removed' },
    )
  }

  /** O valor de uma variável secreta do contêiner. ⛔ Só entra; nunca volta. */
  async saveEnv(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const by = await this.requireAdmin('saveMcpEnv')
        const id = this.idOf(req)
        this.deps.service.saveEnv(id, req.params.name as string, parseBody(envSchema, req.body).value, by)
        return this.toDto(this.deps.service.get(id))
      },
      { message: 'Variable saved' },
    )
  }

  /** Encerra as instâncias (conversas) de um contêiner — a próxima ferramenta sobe uma nova. */
  async stopInstances(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('stopMcpInstances')
      const id = this.idOf(req)
      this.deps.service.get(id)
      return { stopped: await this.deps.registry.closeInstances({ serverId: id }) }
    })
  }

  /** Conecta AGORA (ignorando o backoff) e lista as ferramentas — o botão "Testar conexão". */
  async test(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('testMcpServer')
      const id = this.idOf(req)
      this.deps.service.get(id)
      const result = await this.deps.registry.test(id)
      return { ok: result.ok, tools: result.tools.length, ...(result.message ? { message: result.message } : {}) }
    })
  }

  async tools(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listMcpTools')
      const id = this.idOf(req)
      this.deps.service.get(id)
      return (await this.deps.registry.probeTools(id)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
    })
  }

  private toDto(server: IMcpServerConfig) {
    const secret = this.deps.service.secretStatus(server.id)
    const status = this.deps.registry.status().find((entry) => entry.id === server.id)
    return {
      id: server.id,
      name: server.name,
      kind: server.kind ?? 'remote',
      ...(server.container ? { container: server.container, env: this.deps.service.envStatus(server.id) } : {}),
      url: server.url,
      transport: server.transport,
      auth: server.auth,
      headerName: server.headerName,
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
        ...(status?.lastError ? { lastError: status.lastError } : {}),
        ...(status?.instances !== undefined ? { instances: status.instances } : {}),
      },
      agents: this.deps.service.usedBy(server.id).map((agent) => ({ id: agent.id, name: agent.name })),
      /** A URL é o MCP do próprio gateway: agente que conversa com agentes pode entrar em recursão. */
      selfReference: server.kind !== 'container' && /\/v1\/mcp\/?$/.test(safePath(server.url)),
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
      updatedBy: server.updatedBy,
    }
  }

  private idOf(req: Request): string {
    return req.params.id as string
  }

  private async requireAdmin(operation: string): Promise<string> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return access.identity?.email ?? access.identity?.id ?? 'admin'
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

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}
