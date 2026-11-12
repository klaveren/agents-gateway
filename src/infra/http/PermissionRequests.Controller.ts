import type { ResourceSecretsService } from '@application/ResourceSecrets.Service'
import { ORIGIN_PROJECT, SECRET_LIMITS, SECRET_SCOPES, TSecretScope } from '@domain/models/ResourceSecret.Model'
import { Request, Response } from 'express'
import { z } from 'zod'
import { PermissionRequestsService } from '@application/PermissionRequests.Service'
import { IDENTITY_HEADERS } from '@domain/Agent.Identity'
import { AGENT_PATCH_FIELDS, TAgentPatch, TAgentPatchField } from '@domain/AgentPatch.Policy'
import { IPermissionRequest, IPermissionRequester } from '@domain/models/PermissionRequest.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { agentBodySchema } from './Request.Schema'
import { viaAccessToken } from './Auth.Controller'
import { ownsSession, resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { agentProjectOf, administers, refuseConnected, requireAgentAdmin, requireAnyAdmin, requireProjectAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'
import { viaSessionCookie } from './Session.Cookie'

export interface IPermissionRequestsControllerDeps {
  /** Ausente (o servidor de teste sem banco): as rotas respondem 404. */
  service?: PermissionRequestsService
  proof?: ICallerProof
  /** A sessão VIVA pelo id (o agente dela, se o turno roda, o dono): é o que ancora a leitura das próprias regras. */
  liveSession?: (sessionId: string) => { agentId: string; status: string; metadata?: Record<string, unknown> } | undefined
  /** As variáveis secretas dos recursos (ver `ResourceSecrets.Service`). Ausente: as rotas delas respondem 404. */
  secrets?: Pick<ResourceSecretsService, 'list' | 'save' | 'remove'>
  /** O tipo de um recurso pelo id (as variáveis de `/resources/:id` são da skill ou do command). */
  resourceKindOf?: (id: string) => 'skill' | 'command' | undefined
  /** O projeto de um recurso (`null` = global; `undefined` = não existe). Ausente: o recurso conta como global (só o admin do gateway). */
  resourceProjectOf?: (id: string) => string | null | undefined
  /** Os projetos com que a skill ou o command é compartilhado. Ausente: nenhum. */
  resourceSharedWithOf?: (id: string) => readonly string[] | undefined
  /** Os projetos com que o agente é compartilhado. Ausente: nenhum. */
  agentSharedWithOf?: (id: string) => readonly string[] | undefined
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
// 🔌 As entradas de `allowedTools` a LIGAR na camada local (ferramenta, `mcp:<id>/*`, `agent:<id>`).
const localToolsSchema = z.object({ allowedTools: z.array(z.string().min(1).max(200)).max(100), reason: z.string().max(1000) }).strict()
const approveSchema = z.object({ confirm: z.array(z.string().max(1000)).max(500).optional(), value: z.string().max(SECRET_LIMITS.value).optional() })
const secretSchema = z.object({ value: z.string().max(SECRET_LIMITS.value).optional(), description: z.string().max(SECRET_LIMITS.description).optional() }).strict()
const secretRequestSchema = z.object({
  scope: z.enum(SECRET_SCOPES as [TSecretScope, ...TSecretScope[]]),
  scopeId: z.string().min(1).max(64),
  /** Skill ou command compartilhado: o projeto cujos valores o pedido preenche (ausente = o do agente que pede, se recebeu; senão a origem). */
  project: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(SECRET_LIMITS.description).optional(),
  reason: z.string().max(1000),
})
const rejectSchema = z.object({ note: z.string().max(500).optional() })

/**
 * OS PEDIDOS DE PERMISSÃO (ver `PermissionRequests.Service`). Tudo só admin (404 para os demais).
 *
 * ⛔ ADMIN DO PROJETO DO ALVO: o pedido, as regras e as variáveis valem para quem administra o projeto do agente (ou do
 * projeto) — o agente global e o recurso global, para o admin do gateway. O gateway não entra no projeto que não é dele.
 *
 * ⛔ APROVAR, só na TELA: a credencial tem de ter vindo do cookie de login (`viaSessionCookie`) e não ser token de
 * acesso. O agente usa a credencial de quem conversa, mas sempre no cabeçalho (o MCP do gateway repassa só ele): pela
 * rota de aprovar ele recebe 403, mesmo sendo a conta de um admin.
 */
export class PermissionRequestsController {
  constructor(private readonly deps: IPermissionRequestsControllerDeps) {
    for (const name of [
      'rules',
      'change',
      'list',
      'listForAgent',
      'listForProject',
      'approve',
      'reject',
      'patchAgent',
      'requestLocalTools',
      'listSecrets',
      'saveSecret',
      'removeSecret',
      'requestSecret',
    ] as const)
      this[name] = this[name].bind(this)
  }

  /**
   * `GET /agents/:agentId/permission-rules` e `GET /projects/:projectId/permission-rules` — as regras e os pedidos abertos.
   * Admin lê qualquer alvo; o agente, só as PRÓPRIAS (ver `ownRules`).
   */
  async rules(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const denied = await this.denial(() => this.admin(refOf(req), 'getPermissionRules'))
      if (!denied) return this.deps.service!.rules(refOf(req))
      const own = await this.ownRules(req)
      if (own) return own
      throw denied
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
      const { service, by } = await this.admin(refOf(req), 'changePermissionRules')
      const body = parseBody(changeSchema, req.body)
      return service.change(refOf(req), body, requesterOf(req, by))
    })
  }

  /** `PATCH /agents/:agentId { patch, reason }` — só os campos pedidos; o que amplia vira pedido (ver `AgentPatch.Policy`). */
  async patchAgent(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin({ agentId: req.params.agentId as string }, 'patchAgent')
      const raw = ((req.body as { patch?: unknown } | undefined)?.patch ?? {}) as Record<string, unknown>
      const body = parseBody(patchSchema, req.body)
      // Só o que veio: um padrão do esquema (`allowedTools: []`) não pode virar campo pedido.
      const patch = Object.fromEntries(Object.entries(body.patch).filter(([field]) => field in raw)) as TAgentPatch
      return service.patchAgent(req.params.agentId as string, { patch, reason: body.reason }, requesterOf(req, by))
    })
  }

  /**
   * `POST /agents/:agentId/local-tool-requests { allowedTools, reason }` — 🔌 ligar ferramenta, MCP ou delegação num agente
   * de projeto CONECTADO, só nesta máquina. ⛔ Nada vale já: cada entrada vira um pedido, aprovado na tela.
   */
  async requestLocalTools(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.admin({ agentId: req.params.agentId as string }, 'requestLocalTools')
      const body = parseBody(localToolsSchema, req.body)
      return service.requestLocalTools(req.params.agentId as string, body, requesterOf(req, by))
    })
  }

  /** `GET /projects/:projectId/permission-requests?status=open|all` — os pedidos para as regras do projeto. */
  async listForProject(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service } = await this.admin({ projectId: req.params.projectId as string }, 'listProjectPermissionRequests')
      return service.list({ projectId: req.params.projectId as string, kind: 'project-rules', all: req.query.status === 'all' })
    })
  }

  /** `GET /permission-requests?agentId=&status=open|all` */
  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      if (!this.deps.service) throw new HttpError(404, 'not_found', 'Not found')
      const view = await requireAnyAdmin(this.deps.proof, 'listPermissionRequests')
      const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined
      const projectId = typeof req.query.projectId === 'string' && req.query.projectId ? req.query.projectId : undefined
      if (agentId) await requireAgentAdmin(this.deps.proof, agentId, 'listPermissionRequests')
      if (projectId) await requireProjectAdmin(this.deps.proof, projectId, 'listPermissionRequests')
      // ⛔ Sem alvo, a lista é a dos projetos que a conta administra (o global, só o gateway).
      return this.deps.service
        .list({ ...(agentId ? { agentId } : {}), ...(projectId ? { projectId } : {}), all: req.query.status === 'all' })
        .filter((request) => administers(view, this.projectOf(request)))
    })
  }

  /** `GET /agents/:agentId/permission-requests?status=open|all` */
  async listForAgent(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service } = await this.admin({ agentId: req.params.agentId as string }, 'listAgentPermissionRequests')
      return service.list({ agentId: req.params.agentId as string, all: req.query.status === 'all' })
    })
  }

  /** `POST /permission-requests/:requestId/approve { confirm }` — ⛔ só a pessoa na tela. */
  async approve(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.decider(req, 'approvePermissionRequest')
      // 🔌 Projeto conectado: as regras e as ferramentas do agente (`agent-local`) vão para a camada local e a variável é
      // valor daqui; o resto mudaria o catálogo.
      const request = service.get(req.params.requestId as string)
      if (request.kind === 'agent-patch' || request.kind === 'project-rules') refuseConnected(this.projectOf(request))
      const { confirm, value } = parseBody(approveSchema, req.body)
      return service.approve(req.params.requestId as string, confirm, { by, onScreen: viaSessionCookie(res) && !viaAccessToken(res) }, value)
    })
  }

  /** `POST /permission-requests/:requestId/reject { note? }` */
  async reject(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { service, by } = await this.decider(req, 'rejectPermissionRequest')
      const { note } = parseBody(rejectSchema, req.body)
      return service.reject(req.params.requestId as string, { by }, note)
    })
  }

  /**
   * `GET /agents/:agentId/secrets` e `GET /resources/:resourceId/secrets[?project=P]` — os nomes e quando mudaram. ⛔ Nunca o
   * valor. Com `project`, os valores DAQUELE projeto (a origem ou um que recebeu o recurso), com os nomes que faltam
   * (`configured: false`).
   */
  async listSecrets(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { scope, scopeId } = this.secretScope(req)
      const { project } = await this.secretAdmin(scope, scopeId, 'listSecrets', queryProject(req))
      return this.deps.secrets!.list(scope, scopeId, project)
    })
  }

  /**
   * `PUT …/secrets/:name { value?, description? }` — ⛔ SÓ NA TELA, como aprovar: o valor entra pela pessoa, nunca por um
   * agente ou token de acesso. A resposta não traz o valor.
   */
  async saveSecret(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { scope, scopeId } = this.secretScope(req)
      const { by, project } = await this.secretAdmin(scope, scopeId, 'saveSecret', queryProject(req))
      if (!(viaSessionCookie(res) && !viaAccessToken(res))) throw new HttpError(403, 'forbidden', 'Só quem administra, entrando pela tela, grava uma variável secreta.')
      const body = parseBody(secretSchema, req.body)
      return this.deps.secrets!.save(scope, scopeId, { name: String(req.params.name), ...body }, by, project)
    })
  }

  /** `DELETE …/secrets/:name` — ⛔ só na tela. */
  async removeSecret(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { scope, scopeId } = this.secretScope(req)
      const { project } = await this.secretAdmin(scope, scopeId, 'removeSecret', queryProject(req))
      if (!(viaSessionCookie(res) && !viaAccessToken(res))) throw new HttpError(403, 'forbidden', 'Só quem administra, entrando pela tela, apaga uma variável secreta.')
      if (!this.deps.secrets!.remove(scope, scopeId, String(req.params.name), project)) throw new HttpError(404, 'not_found', `Variable not found: ${String(req.params.name)}`)
      return null
    })
  }

  /** `POST /secret-requests { scope, scopeId, name, description?, reason }` — o agente pede a variável; o valor, só na tela. */
  async requestSecret(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const body = parseBody(secretRequestSchema, req.body)
      const service = this.deps.service
      if (!service) throw new HttpError(404, 'not_found', 'Not found')
      // O agente que pede, de um projeto que RECEBEU a skill, preenche os valores do projeto dele (não os da origem).
      const asked = body.project ?? this.receiverOf(body.scope, body.scopeId, identityOf(req).agentId)
      const { by, project } = await this.secretAdmin(body.scope, body.scopeId, 'requestSecret', asked)
      const { project: _asked, ...input } = body
      return service.requestSecret({ ...input, ...(project !== ORIGIN_PROJECT ? { project } : {}) }, requesterOf(req, by))
    })
  }

  /** O alvo das rotas de variável: o agente, ou a skill ou o command pelo id. */
  private secretScope(req: Request): { scope: TSecretScope; scopeId: string } {
    if (!this.deps.secrets) throw new HttpError(404, 'not_found', 'Not found')
    if (typeof req.params.agentId === 'string') return { scope: 'agent', scopeId: req.params.agentId }
    const id = String(req.params.resourceId)
    const kind = this.deps.resourceKindOf?.(id)
    if (!kind) throw new HttpError(404, 'not_found', `Resource not found: ${id}`)
    return { scope: kind, scopeId: id }
  }

  /** ⛔ O admin do projeto do alvo (o agente ou o projeto da rota; o global, o do gateway). */
  private async admin(ref: { agentId?: string; projectId?: string }, operation: string): Promise<{ service: PermissionRequestsService; by: string }> {
    if (!this.deps.service) throw new HttpError(404, 'not_found', 'Not found')
    const by = ref.agentId ? await requireAgentAdmin(this.deps.proof, ref.agentId, operation) : await requireProjectAdmin(this.deps.proof, ref.projectId, operation)
    return { service: this.deps.service, by }
  }

  /** Aprovar e recusar: o admin do projeto do PEDIDO (ver `projectOf`). */
  private async decider(req: Request, operation: string): Promise<{ service: PermissionRequestsService; by: string }> {
    const service = this.deps.service
    if (!service) throw new HttpError(404, 'not_found', 'Not found')
    await requireAnyAdmin(this.deps.proof, operation)
    const by = await requireProjectAdmin(this.deps.proof, this.projectOf(service.get(req.params.requestId as string)), operation)
    return { service, by }
  }

  /**
   * ⛔ O admin do dono da variável: o projeto do agente, ou do recurso (sem `resourceProjectOf`, global). Com `project`
   * (agente, skill e command): sem ser a origem, o projeto tem de ser um com que o recurso é compartilhado, e quem mexe é o
   * admin DELE (o da origem, ou o gateway, não entra). Tudo o que não passa é 404. `project` devolvido: a chave dos valores.
   */
  private async secretAdmin(scope: TSecretScope | 'resource', scopeId: string, operation: string, asked?: string): Promise<{ by: string; project: string }> {
    if (scope === 'agent') {
      const home = agentProjectOf(scopeId) ?? null
      if (!asked || asked === home) return { by: await requireAgentAdmin(this.deps.proof, scopeId, operation), project: ORIGIN_PROJECT }
      // ⛔ Agente compartilhado: o projeto que o recebeu configura os valores DELE (o segredo da origem não vai junto), e quem
      // mexe é o admin dele. Projeto que não recebeu o agente, e agente global, são 404.
      const by = await requireProjectAdmin(this.deps.proof, asked, operation)
      if (!home || !this.deps.agentSharedWithOf?.(scopeId)?.includes(asked)) throw new HttpError(404, 'not_found', 'Not found')
      return { by, project: asked }
    }
    const origin = this.deps.resourceProjectOf?.(scopeId) ?? null
    if (!asked || asked === origin) return { by: await requireProjectAdmin(this.deps.proof, origin, operation), project: ORIGIN_PROJECT }
    const by = await requireProjectAdmin(this.deps.proof, asked, operation)
    if (!origin || !this.deps.resourceSharedWithOf?.(scopeId)?.includes(asked)) throw new HttpError(404, 'not_found', 'Not found')
    return { by, project: asked }
  }

  /** O projeto do agente que pede, se ele recebeu a skill ou o command por compartilhamento. */
  private receiverOf(scope: TSecretScope, scopeId: string, agentId: string | undefined): string | undefined {
    if (scope === 'agent' || !agentId) return undefined
    const mine = agentProjectOf(agentId)
    return mine && this.deps.resourceSharedWithOf?.(scopeId)?.includes(mine) ? mine : undefined
  }

  /**
   * O projeto de um pedido, o de AGORA do alvo (o do pedido pode ter mudado): o do projeto, o do agente, o do recurso;
   * `null` = global. O que o alvo já não diz (agente apagado) cai no projeto gravado no pedido.
   */
  private projectOf(request: Pick<IPermissionRequest, 'kind' | 'agentId' | 'projectId' | 'secret'>): string | null {
    if (request.kind === 'project-rules') return request.projectId ?? null
    // ⛔ Valor de projeto que recebeu o recurso: quem decide é o admin DELE.
    if (request.kind === 'secret' && request.secret?.project) return request.secret.project
    if (request.kind === 'secret' && request.secret && request.secret.scope !== 'agent') return this.deps.resourceProjectOf?.(request.secret.scopeId) ?? null
    const current = request.agentId ? agentProjectOf(request.agentId) : undefined
    return current !== undefined ? current : (request.projectId ?? null)
  }

  /** O erro de acesso, se o teste negar; `undefined` = passou. */
  private async denial(check: () => Promise<unknown>): Promise<HttpError | undefined> {
    try {
      await check()
      return undefined
    } catch (error: unknown) {
      if (error instanceof HttpError) return error
      throw error
    }
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

/** `?project=P` das rotas de variável (vazio = ausente). */
function queryProject(req: Request): string | undefined {
  return typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
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
