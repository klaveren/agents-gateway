import { Request, Response } from 'express'
import { z } from 'zod'
import { AgentSchedulesService } from '@application/AgentSchedules.Service'
import { ScheduleRunner } from '@application/Schedule.Runner'
import { IAgentSchedule } from '@domain/models/AgentSchedule.Model'
import { provenCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { administers, agentProjectOf, requireAnyAdmin, requireProjectAdmin, requireProjectsAdmin } from './Project.Access'
import { parseBody } from './Request.Parser'

export interface ISchedulesControllerDeps {
  schedules: AgentSchedulesService
  runner: ScheduleRunner
  /** O projeto do agente, para a visão geral recortar por projeto (os globais entram pelo projeto do agendamento). */
  agentProject: (agentId: string) => string | undefined
  proof?: ICallerProof
}

const fields = {
  cron: z.string().max(120),
  timezone: z.string().max(64).optional(),
  prompt: z.string(),
  session: z.enum(['new', 'continuous']).optional(),
  projectId: z.string().max(64).nullable().optional(),
  enabled: z.boolean().optional(),
}
const createSchema = z.object({ name: z.string().max(64), ...fields })
const updateSchema = z.object({ ...fields, cron: fields.cron.optional(), prompt: fields.prompt.optional() })

/**
 * Os agendamentos dos agentes (só o admin do escopo, 404 para os demais, como os hooks): o cadastro, o histórico, o "rodar agora"
 * e a visão geral. Quem dispara no horário é o `ScheduleRunner`.
 *
 * ⚖️ O ESCOPO do agendamento: o projeto do agente; no agente global, o `projectId` do agendamento (onde ele roda) ou,
 * sem ele, o global. ⛔ Cada admin só vê e mexe nos escopos que administra (ver `Project.Access`).
 */
export class SchedulesController {
  constructor(private readonly deps: ISchedulesControllerDeps) {
    for (const name of ['list', 'listAll', 'create', 'update', 'remove', 'run', 'runs'] as const) this[name] = this[name].bind(this)
  }

  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const view = await requireAnyAdmin(this.deps.proof, 'listSchedules')
      const agentId = req.params.agentId as string
      // Agente de projeto: o admin dele, ou nada. Agente global: cada admin vê os agendamentos dos escopos dele.
      const agentProject = agentProjectOf(agentId)
      if (agentProject && !administers(view, agentProject)) await requireProjectAdmin(this.deps.proof, agentProject, 'listSchedules')
      return this.deps.schedules
        .list(agentId)
        .filter((schedule) => administers(view, this.scopeOf(schedule)))
        .map((schedule) => this.toDto(schedule))
    })
  }

  /** Todos — ou, com `?project=`, os dos agentes do projeto e os dos globais que rodam nele —, pela próxima execução. */
  async listAll(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const view = await requireAnyAdmin(this.deps.proof, 'listAllSchedules')
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      const all = this.deps.schedules
        .list()
        .filter((schedule) => administers(view, this.scopeOf(schedule)))
        .filter((schedule) => !project || (this.deps.agentProject(schedule.agentId) ?? schedule.projectId) === project)
      const time = (schedule: ReturnType<SchedulesController['toDto']>) => (schedule.nextRunAt ? schedule.nextRunAt.getTime() : Number.MAX_SAFE_INTEGER)
      return all.map((schedule) => this.toDto(schedule)).sort((a, b) => time(a) - time(b))
    })
  }

  async create(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const agentId = req.params.agentId as string
        const body = parseBody(createSchema, req.body)
        const label = await requireProjectAdmin(this.deps.proof, agentProjectOf(agentId) ?? body.projectId, 'createSchedule')
        const userId = (await provenCaller(this.deps.proof))?.id
        if (!userId) throw new HttpError(422, 'validation_error', 'Sign in with a gateway account to create a schedule: it runs as you')
        const created = this.deps.schedules.create(agentId, body, { userId, label })
        return this.toDto(created)
      },
      { status: 201, message: 'Schedule created' },
    )
  }

  async update(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const agentId = req.params.agentId as string
      const name = req.params.scheduleName as string
      const body = parseBody(updateSchema, req.body)
      const current = this.scopeOfNamed(agentId, name)
      // ⛔ Mudar onde roda (`projectId`) pede admin dos dois escopos.
      const next = body.projectId === undefined || agentProjectOf(agentId) ? current : body.projectId
      const label = await requireProjectsAdmin(this.deps.proof, [current, next], 'updateSchedule')
      return this.toDto(this.deps.schedules.update(agentId, name, body, label))
    })
  }

  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const agentId = req.params.agentId as string
      const name = req.params.scheduleName as string
      await requireProjectAdmin(this.deps.proof, this.scopeOfNamed(agentId, name), 'deleteSchedule')
      this.deps.schedules.remove(agentId, name)
      return null
    })
  }

  /** "Rodar agora": começa na hora e responde sem esperar o turno (o histórico mostra o andamento). */
  async run(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const agentId = req.params.agentId as string
        const name = req.params.scheduleName as string
        await requireProjectAdmin(this.deps.proof, this.scopeOfNamed(agentId, name), 'runSchedule')
        const schedule = this.deps.schedules.get(agentId, name)
        void this.deps.runner.runNow(schedule)
        return { started: true }
      },
      { status: 202, message: 'Schedule started' },
    )
  }

  async runs(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const agentId = req.params.agentId as string
      const name = req.params.scheduleName as string
      await requireProjectAdmin(this.deps.proof, this.scopeOfNamed(agentId, name), 'listScheduleRuns')
      return this.deps.schedules.runs(agentId, name)
    })
  }

  private toDto(schedule: IAgentSchedule) {
    const last = this.deps.schedules.runs(schedule.agentId, schedule.name)[0]
    const nextRunAt = this.deps.schedules.nextRun(schedule)
    return {
      agentId: schedule.agentId,
      name: schedule.name,
      cron: schedule.cron,
      timezone: schedule.timezone,
      prompt: schedule.prompt,
      session: schedule.session,
      ...(schedule.sessionId ? { sessionId: schedule.sessionId } : {}),
      ...(schedule.projectId ? { projectId: schedule.projectId } : {}),
      enabled: schedule.enabled,
      runAs: schedule.runAs,
      failures: schedule.failures,
      ...(schedule.pausedReason ? { pausedReason: schedule.pausedReason } : {}),
      ...(nextRunAt ? { nextRunAt } : {}),
      ...(last ? { lastRun: last } : {}),
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
      updatedBy: schedule.updatedBy,
    }
  }

  /** O escopo do agendamento: o projeto do agente; no global, onde ele roda; sem nada, o global (`null`). */
  private scopeOf(schedule: IAgentSchedule): string | null {
    return agentProjectOf(schedule.agentId) ?? this.deps.agentProject(schedule.agentId) ?? schedule.projectId ?? null
  }

  /** O escopo de um agendamento pelo nome; que não existe cai no do agente (o serviço responde o 404 de sempre). */
  private scopeOfNamed(agentId: string, name: string): string | null {
    try {
      return this.scopeOf(this.deps.schedules.get(agentId, name))
    } catch {
      return agentProjectOf(agentId) ?? this.deps.agentProject(agentId) ?? null
    }
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[SchedulesController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}
