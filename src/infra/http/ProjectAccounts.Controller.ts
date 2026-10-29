import { Request, Response } from 'express'
import { z } from 'zod'
import { AccountValidationError, ProjectAccountsService } from '@application/ProjectAccounts.Service'
import { ACCOUNT_ID, exposesSecret, IProjectAccount, PROJECT_ACCOUNT_KINDS, TProjectAccountKind } from '@domain/models/ProjectAccount.Model'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

export interface IProjectAccountsControllerDeps {
  accounts: ProjectAccountsService
  projectExists: (projectId: string) => boolean
  proof?: ICallerProof
}

const saveSchema = z.object({
  kind: z.enum(PROJECT_ACCOUNT_KINDS as [TProjectAccountKind, ...TProjectAccountKind[]]),
  label: z.string().max(80).default(''),
  public: z
    .object({
      owner: z.string().trim().max(39).optional(),
      appId: z.string().trim().max(12).optional(),
      installationId: z.string().trim().max(15).optional(),
      repositories: z.array(z.string().trim().max(100)).max(100).optional(),
      envName: z.string().trim().max(64).optional(),
      gcpProject: z.string().trim().max(30).optional(),
    })
    .default({}),
  secret: z.string().max(16_384).optional(),
})

/** O que a tela recebe: nunca o segredo, e o aviso quando o comando o vê inteiro. */
function view(account: IProjectAccount) {
  return { ...account, exposesSecret: exposesSecret(account.kind) }
}

/**
 * As contas de um projeto (só admin; 404 para os demais). ⛔ O segredo entra e nunca sai: a resposta traz só o
 * público (dono, ids, o fim do segredo).
 */
export class ProjectAccountsController {
  constructor(private readonly deps: IProjectAccountsControllerDeps) {
    for (const name of ['list', 'save', 'remove', 'test'] as const) this[name] = this[name].bind(this)
  }

  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'listAccounts')
      return { projectId, accounts: this.deps.accounts.list(projectId).map(view) }
    })
  }

  async save(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId, by } = await this.admin(req, 'saveAccount')
      const id = this.accountId(req)
      const body = parseBody(saveSchema, req.body)
      const publicInput = Object.fromEntries(Object.entries(body.public).filter(([, value]) => value !== undefined && value !== ''))
      try {
        return view(
          this.deps.accounts.save(projectId, id, { kind: body.kind, label: body.label, public: publicInput, ...(body.secret?.trim() ? { secret: body.secret } : {}) }, by),
        )
      } catch (error: unknown) {
        if (error instanceof AccountValidationError)
          throw new HttpError(
            422,
            'validation_error',
            error.message,
            error.issues.map((message) => ({ field: message.split(':')[0], message })),
          )
        throw error
      }
    })
  }

  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'removeAccount')
      const id = this.accountId(req)
      if (!this.deps.accounts.remove(projectId, id)) throw new HttpError(404, 'not_found', `Account not found: ${id}`)
      return { removed: id }
    })
  }

  async test(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const { projectId } = await this.admin(req, 'testAccount')
      const id = this.accountId(req)
      if (!this.deps.accounts.get(projectId, id)) throw new HttpError(404, 'not_found', `Account not found: ${id}`)
      try {
        return { ok: true, detail: await this.deps.accounts.test(projectId, id) }
      } catch (error: unknown) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  private accountId(req: Request): string {
    const id = String(req.params.accountId ?? '')
    if (!ACCOUNT_ID.test(id)) throw new HttpError(422, 'validation_error', 'id: minúsculas, números e hífen (ex.: github-empresa1)')
    return id
  }

  private async admin(req: Request, operation: string): Promise<{ projectId: string; by: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    const projectId = req.params.projectId as string
    if (!this.deps.projectExists(projectId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
    return { projectId, by: access.identity?.email ?? access.identity?.id ?? 'admin' }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ProjectAccountsController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
