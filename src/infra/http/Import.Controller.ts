import { Request, Response } from 'express'
import { z } from 'zod'
import { IMPORT_BATCH_MAX, IMPORT_BATCH_NAME_MAX, ImportBatchService } from '@application/ImportBatch.Service'
import { ImportJobError, ImportJobService } from '@application/ImportJob.Service'
import { ImportPlanError, ImportPlanUseCase } from '@application/ImportPlan.Usecase'
import { ImportScanUseCase } from '@application/ImportScan.Usecase'
import { ignoreIssues, IMPORT_IGNORE_MAX } from '@domain/Import.Ignore'
import { IMPORT_MANUAL_STATES, TImportManualState } from '@domain/models/ImportJob.Model'
import { TInventoryKind } from '@domain/models/ImportInventory.Model'
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
  /** Os trabalhos de importação (a varredura salva). Ausente: as rotas respondem 404. */
  jobs?: ImportJobService
  /** Os lotes por seleção de um trabalho. Ausente: as rotas respondem 404. */
  batches?: ImportBatchService
  projectExists: (projectId: string) => boolean
  ignore?: IImportIgnoreStore
  proof?: ICallerProof
}

const patterns = z.array(z.string().max(1_000)).max(IMPORT_IGNORE_MAX)
const scanSchema = z.object({ repository: z.string().min(1).max(100), ignore: patterns.optional() })
const ignoreSchema = z.object({ patterns })
const INVENTORY_KINDS = [
  'skill',
  'command',
  'rule',
  'spec',
  'adr',
  'knowledge',
  'agent',
  'trigger',
  'mcp',
  'config',
  'unknown',
  'skip',
] as const satisfies readonly TInventoryKind[]
const itemSchema = z
  .object({
    key: z.string().min(1).max(1_000),
    state: z.enum(IMPORT_MANUAL_STATES as [TImportManualState, ...TImportManualState[]]).optional(),
    kind: z.enum(INVENTORY_KINDS).nullable().optional(),
  })
  .refine((body) => body.state !== undefined || body.kind !== undefined, { message: 'state or kind is required', path: ['state'] })
const planSchema = z.object({
  repository: z.string().min(1).max(100),
  agent: z.string().min(1).max(200),
  prefix: z.string().max(16).optional(),
  ignore: patterns.optional(),
  job: z.string().min(1).max(100).optional(),
})
const selectionSchema = z.object({
  keys: z.array(z.string().min(1).max(1_000)).min(1).max(IMPORT_BATCH_MAX),
  prefix: z.string().max(16).optional(),
})
const batchSchema = selectionSchema.extend({ name: z.string().trim().min(1).max(IMPORT_BATCH_NAME_MAX) })

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
    const jobs = deps.jobs
    this.planner = deps.plan ?? new ImportPlanUseCase({ scan: deps.scan, ...(jobs ? { jobStates: (projectId, jobId) => jobs.statesOf(projectId, jobId) } : {}) })
    this.scan = this.scan.bind(this)
    this.plan = this.plan.bind(this)
    this.getIgnore = this.getIgnore.bind(this)
    this.setIgnore = this.setIgnore.bind(this)
    this.listJobs = this.listJobs.bind(this)
    this.createJob = this.createJob.bind(this)
    this.getJob = this.getJob.bind(this)
    this.updateItem = this.updateItem.bind(this)
    this.planBatch = this.planBatch.bind(this)
    this.createBatch = this.createBatch.bind(this)
    this.listBatches = this.listBatches.bind(this)
    this.getBatch = this.getBatch.bind(this)
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
   * `POST /projects/:id/import/plan { repository, agent, prefix?, ignore?, job? }` — o LOTE de um agente: o fecho em
   * ordem, o mapa de ids, o alcance traduzido e a estimativa. O que já está no catálogo do projeto (e, com `job`, o
   * aprovado no trabalho) fica marcado, sem conversa. ⛔ Só leitura: nada grava nem dispara construtor.
   */
  async plan(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importPlan', req, async (projectId) => {
      const { repository, agent, prefix, ignore, job } = parseBody(planSchema, req.body)
      const issues = ignore ? ignoreIssues(ignore, 'ignore') : []
      if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)
      try {
        return this.planner.execute(projectId, { repository, agent, ...(prefix !== undefined ? { prefix } : {}), ...(ignore ? { ignore } : {}), ...(job ? { job } : {}) })
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

  /** `GET /projects/:id/import/jobs` — os trabalhos de importação do projeto, do mais novo ao mais velho. */
  async listJobs(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importJobs', req, async (projectId) => this.jobs().list(projectId))
  }

  /**
   * `POST /projects/:id/import/jobs { repository, ignore? }` — analisa o repositório e SALVA o trabalho, reaproveitando
   * o estado do trabalho mais novo do mesmo repositório. ⛔ Não grava no catálogo nem dispara construtor.
   */
  async createJob(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'createImportJob', req, async (projectId, by) => {
      const { repository, ignore } = parseBody(scanSchema, req.body)
      const issues = ignore ? ignoreIssues(ignore, 'ignore') : []
      if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)
      try {
        return this.jobs().create(projectId, repository, by, ignore ? { ignore } : {})
      } catch (error) {
        if (error instanceof WorkFolderError) throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'repository', message: error.message }])
        throw error
      }
    })
  }

  /** `GET /projects/:id/import/jobs/:job` — o trabalho: o inventário salvo e o estado de cada item. */
  async getJob(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importJob', req, async (projectId) => this.jobError(() => this.jobs().get(projectId, req.params.job as string)))
  }

  /**
   * `PATCH /projects/:id/import/jobs/:job/items { key, state?, kind? }` — excluir (`skipped`), incluir (`pending`) e
   * reclassificar (`kind`; `null` volta ao detectado) um item. A chave vai no corpo: tem `:` e `/`.
   */
  async updateItem(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'updateImportItem', req, async (projectId, by) => {
      const body = parseBody(itemSchema, req.body)
      const change = { ...(body.state !== undefined ? { state: body.state } : {}), ...(body.kind !== undefined ? { kind: body.kind } : {}) }
      return this.jobError(() => this.jobs().updateItem(projectId, req.params.job as string, body.key, change, by))
    })
  }

  /**
   * `POST /projects/:id/import/jobs/:job/batches/plan { keys, prefix? }` — o LOTE DA SELEÇÃO, sem salvar: a ordem só
   * entre os escolhidos, os ciclos, o mapa de ids, as citações para fora e a estimativa. ⛔ Só leitura.
   */
  async planBatch(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'planImportBatch', req, async (projectId) => {
      const { keys, prefix } = parseBody(selectionSchema, req.body)
      return this.jobError(() => this.batches().plan(projectId, req.params.job as string, { keys, ...(prefix !== undefined ? { prefix } : {}) }))
    })
  }

  /**
   * `POST /projects/:id/import/jobs/:job/batches { name, keys, prefix? }` — SALVA o lote da seleção no trabalho mais
   * novo do repositório (nome, itens, ordem, autor e hora). ⛔ Não dispara nada nem grava no catálogo.
   */
  async createBatch(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'createImportBatch', req, async (projectId, by) => {
      const { name, keys, prefix } = parseBody(batchSchema, req.body)
      return this.jobError(() => this.batches().create(projectId, req.params.job as string, { name, keys, ...(prefix !== undefined ? { prefix } : {}) }, by))
    })
  }

  /** `GET /projects/:id/import/jobs/:job/batches` — os lotes salvos do trabalho, do mais novo ao mais velho. */
  async listBatches(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importBatches', req, async (projectId) => this.jobError(() => this.batches().list(projectId, req.params.job as string)))
  }

  /** `GET /projects/:id/import/jobs/:job/batches/:batch` — o lote salvo, com o lote recalculado sobre o estado de agora. */
  async getBatch(req: Request, res: Response): Promise<void> {
    await this.respond(res, 'importBatch', req, async (projectId) => this.jobError(() => this.batches().get(projectId, req.params.job as string, req.params.batch as string)))
  }

  private batches(): ImportBatchService {
    if (!this.deps.batches) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.batches
  }

  private jobs(): ImportJobService {
    if (!this.deps.jobs) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.jobs
  }

  /** O erro do trabalho na resposta: o de outro projeto não existe aqui (404); o antigo e a transição são conflito (409). */
  private jobError<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      if (!(error instanceof ImportJobError)) throw error
      if ((error.code === 'not_found' || error.code === 'invalid') && error.field)
        throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: error.field, message: error.message }])
      if (error.code === 'not_found') throw new HttpError(404, 'not_found', error.message)
      if (error.code === 'outdated') throw new HttpError(409, 'import_job_outdated', error.message)
      throw new HttpError(409, 'import_state_conflict', error.message, error.field ? [{ field: error.field, message: error.message }] : undefined)
    }
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
