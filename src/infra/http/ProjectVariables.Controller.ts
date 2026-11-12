import { Request, Response } from 'express'
import { z } from 'zod'
import { ProjectVariableError, ProjectVariablesService } from '@application/ProjectVariables.Service'
import { PROJECT_ENV_LIMITS } from '@domain/models/Project.Model'
import { SECRET_LIMITS } from '@domain/models/ResourceSecret.Model'
import { viaAccessToken } from './Auth.Controller'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { requireProjectAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'
import { viaSessionCookie } from './Session.Cookie'

export interface IProjectVariablesControllerDeps {
  variables?: ProjectVariablesService
  proof?: ICallerProof
}

const secretSchema = z.object({ value: z.string().max(SECRET_LIMITS.value).optional(), description: z.string().max(SECRET_LIMITS.description).optional() }).strict()
const mcpValueSchema = z.object({ value: z.string().max(Math.max(SECRET_LIMITS.value, PROJECT_ENV_LIMITS.value)) }).strict()

/**
 * As variáveis do projeto (Projeto → Ambiente → Variáveis), só o admin do projeto (404 para os demais).
 * ⛔ O VALOR SECRETO SÓ ENTRA, E SÓ PELA TELA: a credencial veio do cookie de login e não é token de acesso — nem agente
 * nem integração grava segredo. Nenhuma resposta traz o valor de uma secreta.
 * 🔌 Num projeto conectado, as secretas são desta máquina (nunca vão à origem); o valor VISÍVEL de um MCP vem da origem.
 */
export class ProjectVariablesController {
  constructor(private readonly deps: IProjectVariablesControllerDeps) {
    for (const name of ['secrets', 'saveSecret', 'removeSecret', 'mcpVariables', 'saveMcpVariable', 'removeMcpVariable', 'moveAccount'] as const) this[name] = this[name].bind(this)
  }

  /** `GET /projects/:projectId/secrets` — os nomes e "configurado", nunca o valor. */
  async secrets(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'listProjectSecrets')
      return this.service().secrets(projectId)
    })
  }

  /** `PUT /projects/:projectId/secrets/:name { value?, description? }` — só na tela. */
  async saveSecret(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'saveProjectSecret')
      this.screenOnly(res, 'grava uma variável secreta')
      return this.service().saveSecret(projectId, { name: String(req.params.name), ...parseBody(secretSchema, req.body) }, by)
    })
  }

  /** `DELETE /projects/:projectId/secrets/:name` — só na tela. */
  async removeSecret(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'removeProjectSecret')
      this.screenOnly(res, 'apaga uma variável secreta')
      if (!this.service().removeSecret(projectId, String(req.params.name))) throw new HttpError(404, 'not_found', `Variable not found: ${String(req.params.name)}`)
      return null
    })
  }

  /** `GET /projects/:projectId/mcp-variables` — os MCPs que pedem valor ao projeto e o que ele já deu. */
  async mcpVariables(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'listProjectMcpVariables')
      return this.service().mcpVariables(projectId)
    })
  }

  /** `PUT /projects/:projectId/mcp-variables/:server/:name { value }` — a secreta, só na tela; a visível, nunca num conectado. */
  async saveMcpVariable(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'saveProjectMcpVariable')
      const server = String(req.params.server)
      const name = String(req.params.name)
      this.guardKind(res, projectId, server, name)
      return this.service().saveMcpVariable(projectId, server, name, parseBody(mcpValueSchema, req.body).value, by)
    })
  }

  async removeMcpVariable(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'removeProjectMcpVariable')
      const server = String(req.params.server)
      const name = String(req.params.name)
      this.guardKind(res, projectId, server, name)
      if (!this.service().removeMcpVariable(projectId, server, name, by)) throw new HttpError(404, 'not_found', `No value for ${server}/${name}`)
      return null
    })
  }

  /** `POST /projects/:projectId/accounts/:accountId/move-to-variables` — a conta "variável secreta" vira secreta do projeto. */
  async moveAccount(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'moveAccountToVariables')
      this.screenOnly(res, 'move uma conta para as variáveis')
      return this.service().moveAccount(projectId, String(req.params.accountId), by)
    })
  }

  /**
   * ⛔ A secreta só pela tela. A visível vale também pela API; no projeto conectado ela é DESTA MÁQUINA (o serviço a grava
   * na conexão, por cima da que veio da origem — ver `IProjectConnection.localMcpEnv`).
   */
  private guardKind(res: Response, projectId: string, server: string, name: string): void {
    if (this.service().kindOf(projectId, server, name).secret) this.screenOnly(res, 'grava uma variável secreta')
  }

  private screenOnly(res: Response, what: string): void {
    if (!(viaSessionCookie(res) && !viaAccessToken(res))) throw new HttpError(403, 'forbidden', `Só quem administra, entrando pela tela, ${what}.`)
  }

  private service(): ProjectVariablesService {
    if (!this.deps.variables) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.variables
  }

  private async admin(req: Request, operation: string): Promise<{ projectId: string; by: string }> {
    // ⛔ O admin DO PROJETO da rota (o do gateway só entra no projeto de que é admin).
    const projectId = req.params.projectId as string
    return { projectId, by: await requireProjectAdmin(this.deps.proof, projectId, operation) }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error instanceof ProjectVariableError ? new HttpError(error.status, codeOf(error.status), error.message) : error)
      if (failure.status >= 500) console.error('[ProjectVariablesController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

const codeOf = (status: number) => (status === 404 ? 'not_found' : status === 409 ? 'variable_exists' : 'validation_error')
