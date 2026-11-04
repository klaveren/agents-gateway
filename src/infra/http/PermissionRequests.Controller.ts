import { Request, Response } from 'express'
import { z } from 'zod'
import { PermissionRequestsService } from '@application/PermissionRequests.Service'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { AGENT_PATCH_FIELDS, TAgentPatch, TAgentPatchField } from '@domain/AgentPatch.Policy'
import { IPermissionRequester } from '@domain/models/PermissionRequest.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { agentBodySchema } from './Request.Schema'
import { viaAccessToken } from './Auth.Controller'
import { ownsSession, resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { viaSessionCookie } from './Session.Cookie'

export interface IPermissionRequestsControllerDeps {
  /** Ausente (o servidor de teste sem banco): as rotas respondem 404. */
  service?: PermissionRequestsService
  proof?: ICallerProof
  /** A sessão VIVA pelo id (o agente dela, se o turno roda, o dono): é o que ancora a leitura das próprias regras. */
  liveSession?: (sessionId: string) => { agentId: string; status: string; metadata?: Record<string, unknown> } | undefined
}

// ⚖️ As regras em si NÃO passam por zod aqui: o validador é o do formulário do agente (`permissionIssues`), com as
// mesmas mensagens campo a campo. Só o formato de fora é conferido.
const changeSchema = z.object({
  add: z.array(z.unknown()).optional(),
  remove: z.array(z.unknown()).optional(),
  reason: z.string().max(1000),
})
// O `patch_agent`: os campos do `PUT /agents` que o patch muda (sem id, arquivos e problemas da importação).
const patchFields = Object.fromEntries(AGENT_PATCH_FIELDS.map((field) => [field, true])) as { [K in TAgentPatchField]: true }
const patchSchema = z.object({ patch: agentBodySchema.pick(patchFields).partial().strict(), reason: z.string().max(1000) })
const approveSchema = z.object({ confirm: z.array(z.string().max(1000)).max(500).optional() })
const rejectSchema = z.object({ note: z.string().max(500).optional() })

/**
 * OS PEDIDOS DE PERMISSÃO (ver `PermissionRequests.Service`). Tudo só admin (404 para os demais).
 *
 * ⛔ APROVAR, só na TELA: a credencial tem de ter vindo do cookie de login (`viaSessionCookie`) e não ser token de
 * acesso. O agente usa a credencial de quem conversa, mas sempre no cabeçalho (o MCP do gateway repassa só ele): pela
 * rota de aprovar ele recebe 403, mesmo sendo a conta de um admin.
 */
export class PermissionRequestsController {
  constructor(private readonly deps: IPermissionRequestsControllerDeps) {
    for (const name of ['rules', 'change', 'list', 'listForAgent', 'listForProject', 'approve', 'reject', 'patchAgent'] as const) this[name] = this[name].bind(this)
  }

  /**
   * `GET /agents/:agentId/permission-rules` e `GET /projects/:projectId/permission-rules` — as regras e os pedidos abertos.
   * Admin lê qualquer alvo; o agente, só as PRÓPRIAS (ver `ownRules`).
   */
  async rules(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const access = await checkAdminAccess(this.deps.proof)
      if (access.allowed && this.deps.service) return this.deps.service.rules(refOf(req))
      const own = await this.ownRules(req)
      if (own) return own
      if (!access.allowed) console.warn('[admin] acesso negado a getPermissionRules:', access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    })
  }

  /**
   * ⛔ O AGENTE LENDO AS PRÓPRIAS REGRAS (só leitura), sem ser admin. Quem ele é NÃO vem do argumento: a conversa do
   * cabeçalho de identidade tem de ser uma sessão viva, com o turno rodando, DESTE agente (o da rota e o do cabeçalho) e
   * da conta provada que chama. Qualquer outro agente, ou um projeto, segue só para admin.
   */
  private async ownRules(req: Request) {
    const agentId = typeof req.params.agentId === 'string' ? req.params.agentId : undefined
    const { agentId: claimed, conversationId } = identityOf(req)
    if (!this.deps.service || !this.deps.liveSession || !agentId || !conversationId || claimed !== agentId) return undefined
    const resolved = await resolveCaller(this.deps.proof)
    const session = resolved ? this.deps.liveSession(conversationId) : undefined
    if (!resolved || !session || session.status !== 'running' || session.agentId !== agentId || !ownsSession(resolved, session.metadata)) return undefined
    // O agente global responde pelo projeto da conversa: é a camada de baixo que vale para ele ali.
    const project = session.metadata?.[PROJECT_METADATA_KEY]
    return this.deps.service.rules({ agentId }, typeof project === 'string' ? { conversationProjectId: project } : {})
  }

  /** `POST /agents/:agentId/permission-rules` e `POST /projects/:projectId/permission-rules` — restringe já; amplia como pedido. */
  async change(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin('changePermissionRules')
      const body = parseBody(changeSchema, req.body)
      return service.change(refOf(req), body, requesterOf(req, by))
    })
  }

  /** `PATCH /agents/:agentId { patch, reason }` — só os campos pedidos; o que amplia vira pedido (ver `AgentPatch.Policy`). */
  async patchAgent(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin('patchAgent')
      const raw = ((req.body as { patch?: unknown } | undefined)?.patch ?? {}) as Record<string, unknown>
      const body = parseBody(patchSchema, req.body)
      // Só o que veio: um padrão do esquema (`allowedTools: []`) não pode virar campo pedido.
      const patch = Object.fromEntries(Object.entries(body.patch).filter(([field]) => field in raw)) as TAgentPatch
      return service.patchAgent(req.params.agentId as string, { patch, reason: body.reason }, requesterOf(req, by))
    })
  }

  /** `GET /projects/:projectId/permission-requests?status=open|all` — os pedidos para as regras do projeto. */
  async listForProject(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service } = await this.admin('listProjectPermissionRequests')
      return service.list({ projectId: req.params.projectId as string, kind: 'project-rules', all: req.query.status === 'all' })
    })
  }

  /** `GET /permission-requests?agentId=&status=open|all` */
  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service } = await this.admin('listPermissionRequests')
      const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined
      return service.list({ ...(agentId ? { agentId } : {}), ...(projectId ? { projectId } : {}), all: req.query.status === 'all' })
    })
  }

  /** `GET /agents/:agentId/permission-requests?status=open|all` */
  async listForAgent(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service } = await this.admin('listAgentPermissionRequests')
      return service.list({ agentId: req.params.agentId as string, all: req.query.status === 'all' })
    })
  }

  /** `POST /permission-requests/:requestId/approve { confirm }` — ⛔ só a pessoa na tela. */
  async approve(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin('approvePermissionRequest')
      const { confirm } = parseBody(approveSchema, req.body)
      return service.approve(req.params.requestId as string, confirm, { by, onScreen: viaSessionCookie(res) && !viaAccessToken(res) })
    })
  }

  /** `POST /permission-requests/:requestId/reject { note? }` */
  async reject(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin('rejectPermissionRequest')
      const { note } = parseBody(rejectSchema, req.body)
      return service.reject(req.params.requestId as string, { by }, note)
    })
  }

  private async admin(operation: string): Promise<{ service: PermissionRequestsService; by: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed || !this.deps.service) {
      if (!access.allowed) console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return { service: this.deps.service, by: access.identity?.email ?? access.identity?.id ?? 'admin' }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[PermissionRequestsController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** O alvo da rota: o agente (`/agents/:agentId/…`) ou o projeto (`/projects/:projectId/…`). */
function refOf(req: Request): { agentId?: string; projectId?: string } {
  return typeof req.params.agentId === 'string' ? { agentId: req.params.agentId } : { projectId: req.params.projectId as string }
}

/**
 * Quem pede: a conta provada e — RÓTULO — o agente e a conversa dos cabeçalhos de identidade que o gateway manda ao
 * próprio MCP. ⚠️ Não decide nada: quem pode pedir é a conta (admin); o rótulo só diz à pessoa de onde veio.
 */
function requesterOf(req: Request, by: string): IPermissionRequester {
  const { agentId, conversationId } = identityOf(req)
  return { by, ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}) }
}

/** Os cabeçalhos de identidade, se bem formados. ⚠️ Sozinhos não provam nada: quem decide confere contra a sessão viva. */
function identityOf(req: Request): { agentId?: string; conversationId?: string } {
  const header = (name: string) => {
    const value = req.headers[name]
    return typeof value === 'string' && /^[\w.:@-]{1,128}$/.test(value.trim()) ? value.trim() : undefined
  }
  return { agentId: header(IDENTITY_HEADERS.agent), conversationId: header(IDENTITY_HEADERS.conversation) }
}
