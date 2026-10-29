import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IAgentSchedule, IScheduleRun, SCHEDULE_RUNS_KEPT } from '@domain/models/AgentSchedule.Model'
import { IAgentScheduleRepository, TSchedulePatch } from '@domain/ports/AgentScheduleRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_schedules (
    agent_id            TEXT    NOT NULL,
    name                TEXT    NOT NULL,
    cron                TEXT    NOT NULL,
    timezone            TEXT    NOT NULL,
    prompt              TEXT    NOT NULL,
    session             TEXT    NOT NULL DEFAULT 'new',
    session_id          TEXT,
    project_id          TEXT,
    enabled             INTEGER NOT NULL DEFAULT 1,
    run_as              TEXT    NOT NULL,
    failures            INTEGER NOT NULL DEFAULT 0,
    paused_reason       TEXT,
    last_scheduled_for  TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL,
    updated_by          TEXT,
    PRIMARY KEY (agent_id, name)
  );
  CREATE TABLE IF NOT EXISTS agent_schedule_runs (
    id             TEXT NOT NULL PRIMARY KEY,
    agent_id       TEXT NOT NULL,
    schedule_name  TEXT NOT NULL,
    trigger        TEXT NOT NULL,
    scheduled_for  TEXT NOT NULL,
    started_at     TEXT,
    finished_at    TEXT,
    status         TEXT NOT NULL,
    session_id     TEXT,
    error          TEXT
  );
  CREATE INDEX IF NOT EXISTS agent_schedule_runs_schedule ON agent_schedule_runs (agent_id, schedule_name, scheduled_for);
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TSchedulePatch, string> = {
  cron: 'cron',
  timezone: 'timezone',
  prompt: 'prompt',
  session: 'session',
  sessionId: 'session_id',
  projectId: 'project_id',
  enabled: 'enabled',
  failures: 'failures',
  pausedReason: 'paused_reason',
  lastScheduledFor: 'last_scheduled_for',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}
/** Os campos que se apagam com `undefined` no patch (os demais, `undefined` = não mexe). */
const CLEARABLE: ReadonlyArray<keyof TSchedulePatch> = ['sessionId', 'projectId', 'pausedReason']

const RUN_COLUMNS: Record<string, string> = {
  trigger: 'trigger',
  scheduledFor: 'scheduled_for',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  status: 'status',
  sessionId: 'session_id',
  error: 'error',
}

/** Os agendamentos dos agentes, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteAgentScheduleRepository implements IAgentScheduleRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(agentId?: string): IAgentSchedule[] {
    const rows = agentId
      ? this.db.prepare('SELECT * FROM agent_schedules WHERE agent_id = ? ORDER BY created_at ASC, name ASC').all(agentId)
      : this.db.prepare('SELECT * FROM agent_schedules ORDER BY agent_id ASC, created_at ASC').all()
    return (rows as TRow[]).map(toSchedule)
  }

  get(agentId: string, name: string): IAgentSchedule | undefined {
    const row = this.db.prepare('SELECT * FROM agent_schedules WHERE agent_id = ? AND name = ?').get(agentId, name) as TRow | undefined
    return row ? toSchedule(row) : undefined
  }

  insert(schedule: IAgentSchedule): void {
    this.db
      .prepare(
        `INSERT INTO agent_schedules (agent_id, name, cron, timezone, prompt, session, session_id, project_id, enabled, run_as, failures, paused_reason, last_scheduled_for, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        schedule.agentId,
        schedule.name,
        schedule.cron,
        schedule.timezone,
        schedule.prompt,
        schedule.session,
        schedule.sessionId ?? null,
        schedule.projectId ?? null,
        schedule.enabled ? 1 : 0,
        schedule.runAs,
        schedule.failures,
        schedule.pausedReason ?? null,
        schedule.lastScheduledFor?.toISOString() ?? null,
        schedule.createdAt.toISOString(),
        schedule.updatedAt.toISOString(),
        schedule.updatedBy ?? null,
      )
  }

  update(agentId: string, name: string, patch: TSchedulePatch): IAgentSchedule | undefined {
    const keys = (Object.keys(patch) as Array<keyof TSchedulePatch>).filter((key) => key in COLUMNS && (patch[key] !== undefined || CLEARABLE.includes(key)))
    if (keys.length) {
      const values = keys.map((key) => {
        const value = patch[key]
        if (value === undefined || value === null) return null
        if (value instanceof Date) return value.toISOString()
        if (typeof value === 'boolean') return value ? 1 : 0
        return value as string | number
      })
      this.db.prepare(`UPDATE agent_schedules SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE agent_id = ? AND name = ?`).run(...values, agentId, name)
    }
    return this.get(agentId, name)
  }

  delete(agentId: string, name: string): boolean {
    this.db.prepare('DELETE FROM agent_schedule_runs WHERE agent_id = ? AND schedule_name = ?').run(agentId, name)
    return this.db.prepare('DELETE FROM agent_schedules WHERE agent_id = ? AND name = ?').run(agentId, name).changes > 0
  }

  deleteAgent(agentId: string): void {
    this.db.prepare('DELETE FROM agent_schedule_runs WHERE agent_id = ?').run(agentId)
    this.db.prepare('DELETE FROM agent_schedules WHERE agent_id = ?').run(agentId)
  }

  runs(agentId: string, name: string): IScheduleRun[] {
    return (
      this.db
        .prepare('SELECT * FROM agent_schedule_runs WHERE agent_id = ? AND schedule_name = ? ORDER BY scheduled_for DESC, rowid DESC LIMIT ?')
        .all(agentId, name, SCHEDULE_RUNS_KEPT) as TRow[]
    ).map(toRun)
  }

  /** ⚖️ Guarda só as últimas `SCHEDULE_RUNS_KEPT` por agendamento: é para a tela, não um log de auditoria. */
  addRun(run: IScheduleRun): void {
    this.db
      .prepare(
        'INSERT INTO agent_schedule_runs (id, agent_id, schedule_name, trigger, scheduled_for, started_at, finished_at, status, session_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        run.id,
        run.agentId,
        run.scheduleName,
        run.trigger,
        run.scheduledFor.toISOString(),
        run.startedAt?.toISOString() ?? null,
        run.finishedAt?.toISOString() ?? null,
        run.status,
        run.sessionId ?? null,
        run.error ?? null,
      )
    this.db
      .prepare(
        `DELETE FROM agent_schedule_runs WHERE agent_id = ? AND schedule_name = ? AND id NOT IN (
           SELECT id FROM agent_schedule_runs WHERE agent_id = ? AND schedule_name = ? ORDER BY scheduled_for DESC, rowid DESC LIMIT ?)`,
      )
      .run(run.agentId, run.scheduleName, run.agentId, run.scheduleName, SCHEDULE_RUNS_KEPT)
  }

  updateRun(id: string, patch: Partial<Omit<IScheduleRun, 'id' | 'agentId' | 'scheduleName'>>): void {
    const keys = Object.keys(patch).filter((key) => key in RUN_COLUMNS && (patch as Record<string, unknown>)[key] !== undefined)
    if (!keys.length) return
    const values = keys.map((key) => {
      const value = (patch as Record<string, unknown>)[key]
      return value instanceof Date ? value.toISOString() : (value as string)
    })
    this.db.prepare(`UPDATE agent_schedule_runs SET ${keys.map((key) => `${RUN_COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
  }
}

function toSchedule(row: TRow): IAgentSchedule {
  return {
    agentId: String(row.agent_id),
    name: String(row.name),
    cron: String(row.cron),
    timezone: String(row.timezone),
    prompt: String(row.prompt),
    session: String(row.session) as IAgentSchedule['session'],
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
    enabled: Number(row.enabled) === 1,
    runAs: String(row.run_as),
    failures: Number(row.failures),
    ...(typeof row.paused_reason === 'string' ? { pausedReason: row.paused_reason } : {}),
    ...(typeof row.last_scheduled_for === 'string' ? { lastScheduledFor: new Date(row.last_scheduled_for) } : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}

function toRun(row: TRow): IScheduleRun {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    scheduleName: String(row.schedule_name),
    trigger: String(row.trigger) as IScheduleRun['trigger'],
    scheduledFor: new Date(String(row.scheduled_for)),
    ...(typeof row.started_at === 'string' ? { startedAt: new Date(row.started_at) } : {}),
    ...(typeof row.finished_at === 'string' ? { finishedAt: new Date(row.finished_at) } : {}),
    status: String(row.status) as IScheduleRun['status'],
    ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
    ...(typeof row.error === 'string' ? { error: row.error } : {}),
  }
}
