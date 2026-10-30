import { Request, Response } from 'express'
import { z } from 'zod'
import { AgentSchedulesService } from '@application/AgentSchedules.Service'
import { ScheduleRunner } from '@application/Schedule.Runner'
import { IAgentSchedule } from '@domain/models/AgentSchedule.Model'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
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
 * Os agendamentos dos agentes (só admin, 404 para os demais, como os hooks): o cadastro, o histórico, o "rodar agora"
 * e a visão geral. Quem dispara no horário é o `ScheduleRunner`.
 */
export class SchedulesController {
  constructor(private readonly deps: ISchedulesControllerDeps) {
    for (const name of ['list', 'listAll', 'create', 'update', 'remove', 'run', 'runs'] as const) this[name] = this[name].bind(this)
  }

  async list(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listSchedules')
      return this.deps.schedules.list(req.params.agentId as string).map((schedule) => this.toDto(schedule))
    })
  }

  /** Todos — ou, com `?project=`, os dos agentes do projeto e os dos globais que rodam nele —, pela próxima execução. */
  async listAll(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listAllSchedules')
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      const all = this.deps.schedules.list().filter((schedule) => !project || (this.deps.agentProject(schedule.agentId) ?? schedule.projectId) === project)
      const time = (schedule: ReturnType<SchedulesController['toDto']>) => (schedule.nextRunAt ? schedule.nextRunAt.getTime() : Number.MAX_SAFE_INTEGER)
      return all.map((schedule) => this.toDto(schedule)).sort((a, b) => time(a) - time(b))
    })
  }

  async create(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        const caller = await this.requireAdmin('createSchedule')
        if (!caller.userId) throw new HttpError(422, 'validation_error', 'Sign in with a gateway account to create a schedule: it runs as you')
        const created = this.deps.schedules.create(req.params.agentId as string, parseBody(createSchema, req.body), { userId: caller.userId, label: caller.label })
        return this.toDto(created)
      },
      { status: 201, message: 'Schedule created' },
    )
  }

  async update(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      const caller = await this.requireAdmin('updateSchedule')
      return this.toDto(this.deps.schedules.update(req.params.agentId as string, req.params.scheduleName as string, parseBody(updateSchema, req.body), caller.label))
    })
  }

  async remove(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('deleteSchedule')
      this.deps.schedules.remove(req.params.agentId as string, req.params.scheduleName as string)
      return null
    })
  }

  /** "Rodar agora": começa na hora e responde sem esperar o turno (o histórico mostra o andamento). */
  async run(req: Request, res: Response): Promise<void> {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('runSchedule')
        const schedule = this.deps.schedules.get(req.params.agentId as string, req.params.scheduleName as string)
        void this.deps.runner.runNow(schedule)
        return { started: true }
      },
      { status: 202, message: 'Schedule started' },
    )
  }

  async runs(req: Request, res: Response): Promise<void> {
    await this.respond(res, async () => {
      await this.requireAdmin('listScheduleRuns')
      return this.deps.schedules.runs(req.params.agentId as string, req.params.scheduleName as string)
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

  private async requireAdmin(operation: string): Promise<{ userId?: string; label: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return { userId: access.identity?.id, label: access.identity?.email ?? access.identity?.id ?? 'admin' }
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
