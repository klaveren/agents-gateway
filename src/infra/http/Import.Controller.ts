import { Request, Response } from 'express'
import { z } from 'zod'
import { ImportPlanError, ImportPlanUseCase } from '@application/ImportPlan.Usecase'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { ignoreIssues, IMPORT_IGNORE_MAX } from '@domain/Import.Ignore'
import { WorkFolderError } from '@infra/workspace/Work.Folder'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'

/** O ignorar guardado no projeto (`ProjectsService.importIgnore`/`setImportIgnore`). */
export interface IImportIgnoreStore {
  get: (projectId: string) => string[]
  set: (projectId: string, patterns: readonly string[], by: string) => string[]
}

export interface IImportControllerDeps {
  scan: ImportScanUseCase
  /** O lote. Ausente: montado sobre a mesma varredura. */
  plan?: ImportPlanUseCase
  projectExists: (projectId: string) => boolean
  ignore?: IImportIgnoreStore
  proof?: ICallerProof
}

const patterns = z.array(z.string().max(1_000)).max(IMPORT_IGNORE_MAX)
const scanSchema = z.object({ repository: z.string().min(1).max(100), ignore: patterns.optional() })
const ignoreSchema = z.object({ patterns })
const planSchema = z.object({
  repository: z.string().min(1).max(100),
  agent: z.string().min(1).max(200),
  prefix: z.string().max(16).optional(),
  ignore: patterns.optional(),
})

/**
 * O IMPORTADOR de recursos de um repositório do projeto. Por ora a varredura (devolve o inventário e não grava nada),
 * o lote de um agente (fecho, ordem, ids, alcance e estimativa — também só leitura) e o ignorar do projeto (os globs que
 * a varredura pula).
 *
 * ⛔ Só admin (quem administra o projeto), 404 para os demais, como `/projects/:id/members`. O repositório é só o
 * nome da pasta em `<projeto>/repositories/`, resolvido no servidor: repositório de outro projeto não existe aqui.
 */
export class ImportController {
  private readonly planner: ImportPlanUseCase

  constructor(private readonly deps: IImportControllerDeps) {
    this.planner = deps.plan ?? new ImportPlanUseCase({ scan: deps.scan })
    this.scan = this.scan.bind(this)
    this.plan = this.plan.bind(this)
    this.getIgnore = this.getIgnore.bind(this)
    this.setIgnore = this.setIgnore.bind(this)
  }

  /** `POST /projects/:id/import/scan { repository, ignore? }` — o inventário do repositório (só leitura, nada persiste). */
  async scan(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importScan', req, async (projectId) => {
      const { repository, ignore } = parseBody(scanSchema, req.body)
      const issues = ignore ? ignoreIssues(ignore, 'ignore') : []
      if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)
      try {
        return this.deps.scan.execute(projectId, repository, ignore ? { ignore } : {})
      } catch (error) {
        if (error instanceof WorkFolderError) throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'repository', message: error.message }])
        throw error
      }
    })
  }

  /**
   * `POST /projects/:id/import/plan { repository, agent, prefix?, ignore? }` — o LOTE de um agente: o fecho em ordem,
   * o mapa de ids, o alcance traduzido e a estimativa. ⛔ Só leitura: nada grava nem dispara construtor.
   */
  async plan(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importPlan', req, async (projectId) => {
      const { repository, agent, prefix, ignore } = parseBody(planSchema, req.body)
      const issues = ignore ? ignoreIssues(ignore, 'ignore') : []
      if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)
      try {
        return this.planner.execute(projectId, { repository, agent, ...(prefix !== undefined ? { prefix } : {}), ...(ignore ? { ignore } : {}) })
      } catch (error) {
        if (error instanceof WorkFolderError) throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'repository', message: error.message }])
        if (error instanceof ImportPlanError) throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: error.field, message: error.message }])
        throw error
      }
    })
  }

  /** `GET /projects/:id/import/ignore` — os padrões que a varredura ignora neste projeto. */
  async getIgnore(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importIgnore', req, async (projectId) => ({ patterns: this.store().get(projectId) }))
  }

  /** `PUT /projects/:id/import/ignore { patterns }` — troca a lista inteira (vazia apaga). */
  async setIgnore(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'setImportIgnore', req, async (projectId, by) => {
      const body = parseBody(ignoreSchema, req.body)
      return { patterns: this.store().set(projectId, body.patterns, by) }
    })
  }

  private store(): IImportIgnoreStore {
    if (!this.deps.ignore) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.ignore
  }

  private async respond<T>(res: Response, operation: string, req: Request, work: (projectId: string, by: string) => Promise<T>): Promise<void> {
    try {
      const projectId = req.params.id as string
      const access = await checkAdminAccess(this.deps.proof)
      if (!access.allowed) {
        console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
        throw new HttpError(404, 'not_found', 'Not found')
      }
      if (!this.deps.projectExists(projectId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
      const by = access.identity?.email ?? access.identity?.id ?? 'admin'
      res.status(200).json(ok(await work(projectId, by)))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[ImportController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
