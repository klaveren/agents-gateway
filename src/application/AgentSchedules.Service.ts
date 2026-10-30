import { randomBytes } from 'node:crypto'
import { CronError, CronSchedule } from '@domain/Cron.Schedule'
import { InvalidScheduleError, ScheduleNotFoundError } from '@domain/errors/Domain.Error'
import {
  IAgentSchedule,
  IScheduleRun,
  SCHEDULE_DEFAULT_TIMEZONE,
  SCHEDULE_MAX_FAILURES,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_NAME_PATTERN,
  TScheduleSession,
} from '@domain/models/AgentSchedule.Model'
import { IAgentScheduleRepository } from '@domain/ports/AgentScheduleRepository.Port'

export interface IScheduleInput {
  name: string
  cron: string
  timezone?: string
  prompt: string
  session?: TScheduleSession
  projectId?: string | null
  enabled?: boolean
}

export type TScheduleChange = Partial<Omit<IScheduleInput, 'name'>>

/** O agente, para o cadastro: existe, e de que projeto é (agente de projeto não leva outro projeto). */
export interface IScheduleAgent {
  id: string
  projectId?: string
}

const SESSIONS: TScheduleSession[] = ['new', 'continuous']

/**
 * O cadastro dos agendamentos de cada agente e o histórico das execuções. O relógio que dispara mora no
 * `ScheduleRunner`; aqui ficam as regras: cron válido, intervalo mínimo, quem roda, a pausa depois de falhas seguidas.
 */
export class AgentSchedulesService {
  constructor(
    private readonly schedules: IAgentScheduleRepository,
    private readonly agentOf: (agentId: string) => IScheduleAgent | undefined,
    private readonly projectExists: (projectId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Todos, ou os de um agente. */
  list(agentId?: string): IAgentSchedule[] {
    return this.schedules.list(agentId)
  }

  get(agentId: string, name: string): IAgentSchedule {
    const schedule = this.schedules.get(agentId, name)
    if (!schedule) throw new ScheduleNotFoundError(agentId, name)
    return schedule
  }

  /** O próximo horário de um agendamento ligado (de um agente que existe); `undefined` se pausado. */
  nextRun(schedule: IAgentSchedule, after = this.now()): Date | undefined {
    if (!schedule.enabled || !this.agentOf(schedule.agentId)) return undefined
    try {
      return new CronSchedule(schedule.cron, schedule.timezone).next(after)
    } catch {
      return undefined
    }
  }

  create(agentId: string, input: IScheduleInput, by: { userId: string; label: string }): IAgentSchedule {
    const issues = this.issues(agentId, input)
    if (!SCHEDULE_NAME_PATTERN.test(input.name ?? '')) issues.unshift({ field: 'name', message: 'use 2–48 lowercase letters, digits or hyphens' })
    else if (this.schedules.get(agentId, input.name)) issues.unshift({ field: 'name', message: `already exists: ${input.name}` })
    if (issues.length) throw new InvalidScheduleError(issues)
    const now = this.now()
    const schedule: IAgentSchedule = {
      agentId,
      name: input.name,
      cron: input.cron.trim(),
      timezone: input.timezone?.trim() || SCHEDULE_DEFAULT_TIMEZONE,
      prompt: input.prompt.trim(),
      session: input.session ?? 'new',
      ...(input.projectId ? { projectId: input.projectId } : {}),
      enabled: input.enabled ?? true,
      runAs: by.userId,
      failures: 0,
      // Nasce "em dia": as execuções de antes de existir não contam como perdidas.
      lastScheduledFor: now,
      createdAt: now,
      updatedAt: now,
      updatedBy: by.label,
    }
    this.schedules.insert(schedule)
    return schedule
  }

  /** Religar zera as falhas e a pausa do sistema; trocar o modo larga a conversa contínua. */
  update(agentId: string, name: string, change: TScheduleChange, by: string): IAgentSchedule {
    const current = this.get(agentId, name)
    const next = { ...current, ...definedOf(change) }
    const issues = this.issues(agentId, { ...next, projectId: change.projectId === undefined ? current.projectId : change.projectId })
    if (issues.length) throw new InvalidScheduleError(issues)
    const resumed = change.enabled === true && !current.enabled
    return this.schedules.update(agentId, name, {
      cron: next.cron.trim(),
      timezone: next.timezone,
      prompt: next.prompt.trim(),
      session: next.session,
      ...(change.session && change.session !== current.session ? { sessionId: undefined } : {}),
      ...(change.projectId !== undefined ? { projectId: change.projectId || undefined } : {}),
      enabled: next.enabled,
      ...(resumed ? { failures: 0, pausedReason: undefined, lastScheduledFor: this.now() } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
  }

  remove(agentId: string, name: string): void {
    this.get(agentId, name)
    this.schedules.delete(agentId, name)
  }

  removeAgent(agentId: string): void {
    this.schedules.deleteAgent(agentId)
  }

  runs(agentId: string, name: string): IScheduleRun[] {
    this.get(agentId, name)
    return this.schedules.runs(agentId, name)
  }

  /** Uma execução que começa (ou que só se registra: `skipped`, `missed`). */
  recordRun(schedule: IAgentSchedule, run: Pick<IScheduleRun, 'trigger' | 'scheduledFor' | 'status'> & { error?: string }): IScheduleRun {
    const now = this.now()
    const record: IScheduleRun = {
      id: `scr_${randomBytes(9).toString('base64url')}`,
      agentId: schedule.agentId,
      scheduleName: schedule.name,
      trigger: run.trigger,
      scheduledFor: run.scheduledFor,
      ...(run.status === 'running' ? { startedAt: now } : { finishedAt: now }),
      status: run.status,
      ...(run.error ? { error: run.error } : {}),
    }
    this.schedules.addRun(record)
    return record
  }

  /**
   * O fim de uma execução. ⛔ Falhas SEGUIDAS pausam o agendamento (`SCHEDULE_MAX_FAILURES`): um agente quebrado não
   * fica gastando tokens a cada horário sem ninguém olhando. Um sucesso zera a contagem.
   */
  finishRun(schedule: IAgentSchedule, runId: string, outcome: { sessionId?: string; error?: string }): void {
    this.schedules.updateRun(runId, {
      status: outcome.error ? 'error' : 'ok',
      finishedAt: this.now(),
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    })
    const current = this.schedules.get(schedule.agentId, schedule.name)
    if (!current) return
    if (!outcome.error) {
      if (current.failures) this.schedules.update(schedule.agentId, schedule.name, { failures: 0 })
      return
    }
    const failures = current.failures + 1
    const pause = failures >= SCHEDULE_MAX_FAILURES
    this.schedules.update(schedule.agentId, schedule.name, {
      failures,
      ...(pause ? { enabled: false, pausedReason: `Pausado depois de ${failures} falhas seguidas: ${outcome.error}` } : {}),
    })
  }

  /** O horário que acabou de passar (rodando ou não): é a marca para achar as execuções perdidas no próximo boot. */
  markScheduled(schedule: IAgentSchedule, scheduledFor: Date): void {
    this.schedules.update(schedule.agentId, schedule.name, { lastScheduledFor: scheduledFor })
  }

  setSession(schedule: IAgentSchedule, sessionId: string): void {
    this.schedules.update(schedule.agentId, schedule.name, { sessionId })
  }

  private issues(agentId: string, input: Partial<IScheduleInput>): Array<{ field: string; message: string }> {
    const issues: Array<{ field: string; message: string }> = []
    const agent = this.agentOf(agentId)
    if (!agent) issues.push({ field: 'agentId', message: `no such agent: ${agentId}` })
    // ⚖️ O prompt não tem teto: o tamanho é de quem cria o agendamento.
    if (!input.prompt?.trim()) issues.push({ field: 'prompt', message: 'required: what the agent runs, as typed in the chat (/command args works)' })
    if (input.session && !SESSIONS.includes(input.session)) issues.push({ field: 'session', message: `one of ${SESSIONS.join(', ')}` })
    try {
      const cron = new CronSchedule(input.cron ?? '', input.timezone?.trim() || SCHEDULE_DEFAULT_TIMEZONE)
      // O intervalo mínimo, medido nas próximas execuções (não só nas duas primeiras: "0,1 * * * *" engana).
      const upcoming = cron.upcoming(this.now(), 12)
      if (!upcoming.length) issues.push({ field: 'cron', message: 'never runs' })
      for (let index = 1; index < upcoming.length; index += 1)
        if (upcoming[index].getTime() - upcoming[index - 1].getTime() < SCHEDULE_MIN_INTERVAL_MS) {
          issues.push({ field: 'cron', message: `runs more often than every ${SCHEDULE_MIN_INTERVAL_MS / 60_000} minutes` })
          break
        }
    } catch (error: unknown) {
      issues.push({ field: error instanceof CronError && /timezone/.test(error.message) ? 'timezone' : 'cron', message: error instanceof Error ? error.message : String(error) })
    }
    // ⛔ O projeto é só para agente global: o de projeto já trabalha no dele.
    if (input.projectId) {
      if (agent?.projectId) issues.push({ field: 'projectId', message: 'a project agent already runs in its own project' })
      else if (!this.projectExists(input.projectId)) issues.push({ field: 'projectId', message: `no such project: ${input.projectId}` })
    }
    return issues
  }
}

function definedOf<T extends object>(change: T): Partial<T> {
  return Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as Partial<T>
}
