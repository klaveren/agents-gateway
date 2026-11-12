import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IWatch, TWatchKind, TWatchStatus } from '@domain/models/Watch.Model'
import { IWatchRepository, TWatchPatch } from '@domain/ports/WatchRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversation_watches (
    id                 TEXT    NOT NULL PRIMARY KEY,
    session_id         TEXT    NOT NULL,
    agent_id           TEXT    NOT NULL,
    run_as             TEXT    NOT NULL,
    kind               TEXT    NOT NULL,
    label              TEXT    NOT NULL,
    command            TEXT,
    every_seconds      INTEGER,
    then_text          TEXT    NOT NULL,
    status             TEXT    NOT NULL,
    created_at         TEXT    NOT NULL,
    next_check_at      TEXT,
    deadline_at        TEXT    NOT NULL,
    checks             INTEGER NOT NULL DEFAULT 0,
    failures           INTEGER NOT NULL DEFAULT 0,
    last_output        TEXT,
    ended_at           TEXT,
    end_reason         TEXT,
    delivered          INTEGER NOT NULL DEFAULT 0,
    delivery_attempts  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS conversation_watches_session ON conversation_watches (session_id, created_at);
  CREATE INDEX IF NOT EXISTS conversation_watches_due ON conversation_watches (status, delivered, next_check_at);
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TWatchPatch, string> = {
  status: 'status',
  checks: 'checks',
  failures: 'failures',
  endReason: 'end_reason',
  delivered: 'delivered',
  deliveryAttempts: 'delivery_attempts',
  nextCheckAt: 'next_check_at',
  lastOutput: 'last_output',
  endedAt: 'ended_at',
}

const stored = (value: unknown): string | number | null => {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  return value as string | number
}

/** As vigias no mesmo arquivo das conversas (uma conexão a mais; a tabela é só dela). */
export class SqliteWatchRepository implements IWatchRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  insert(watch: IWatch): void {
    this.db
      .prepare(
        `INSERT INTO conversation_watches (id, session_id, agent_id, run_as, kind, label, command, every_seconds, then_text, status, created_at, next_check_at,
           deadline_at, checks, failures, last_output, ended_at, end_reason, delivered, delivery_attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        watch.id,
        watch.sessionId,
        watch.agentId,
        watch.runAs,
        watch.kind,
        watch.label,
        stored(watch.command),
        stored(watch.everySeconds),
        watch.then,
        watch.status,
        watch.createdAt.toISOString(),
        stored(watch.nextCheckAt),
        watch.deadlineAt.toISOString(),
        watch.checks,
        watch.failures,
        stored(watch.lastOutput),
        stored(watch.endedAt),
        stored(watch.endReason),
        stored(watch.delivered),
        watch.deliveryAttempts,
      )
  }

  find(id: string): IWatch | undefined {
    const row = this.db.prepare('SELECT * FROM conversation_watches WHERE id = ?').get(id) as TRow | undefined
    return row ? toWatch(row) : undefined
  }

  listBySession(sessionId: string, limit = 50): IWatch[] {
    const rows = this.db.prepare('SELECT * FROM conversation_watches WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sessionId, limit) as TRow[]
    return rows.map(toWatch)
  }

  countActive(sessionId?: string): number {
    const row = sessionId
      ? this.db.prepare("SELECT COUNT(*) AS total FROM conversation_watches WHERE status = 'active' AND session_id = ?").get(sessionId)
      : this.db.prepare("SELECT COUNT(*) AS total FROM conversation_watches WHERE status = 'active'").get()
    return Number((row as TRow | undefined)?.total ?? 0)
  }

  listDue(now: Date): IWatch[] {
    const at = now.toISOString()
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_watches
          WHERE (status = 'active' AND (next_check_at <= ? OR deadline_at <= ?))
             OR (status <> 'active' AND delivered = 0 AND (next_check_at IS NULL OR next_check_at <= ?))
          ORDER BY COALESCE(next_check_at, deadline_at)`,
      )
      .all(at, at, at) as TRow[]
    return rows.map(toWatch)
  }

  update(id: string, patch: TWatchPatch): void {
    const entries = (Object.keys(patch) as Array<keyof TWatchPatch>).filter((key) => patch[key] !== undefined)
    if (!entries.length) return
    const sets = entries.map((key) => `${COLUMNS[key]} = ?`).join(', ')
    this.db.prepare(`UPDATE conversation_watches SET ${sets} WHERE id = ?`).run(...entries.map((key) => stored(patch[key])), id)
  }

  purge(before: Date): void {
    this.db.prepare("DELETE FROM conversation_watches WHERE status <> 'active' AND delivered = 1 AND ended_at < ?").run(before.toISOString())
  }
}

const date = (value: unknown) => (typeof value === 'string' && value ? new Date(value) : undefined)

function toWatch(row: TRow): IWatch {
  const nextCheckAt = date(row.next_check_at)
  const endedAt = date(row.ended_at)
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    runAs: String(row.run_as),
    kind: row.kind as TWatchKind,
    label: String(row.label),
    ...(typeof row.command === 'string' ? { command: row.command } : {}),
    ...(typeof row.every_seconds === 'number' ? { everySeconds: row.every_seconds } : {}),
    then: String(row.then_text),
    status: row.status as TWatchStatus,
    createdAt: new Date(String(row.created_at)),
    ...(nextCheckAt ? { nextCheckAt } : {}),
    deadlineAt: new Date(String(row.deadline_at)),
    checks: Number(row.checks),
    failures: Number(row.failures),
    ...(typeof row.last_output === 'string' ? { lastOutput: row.last_output } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(typeof row.end_reason === 'string' ? { endReason: row.end_reason } : {}),
    delivered: Number(row.delivered) === 1,
    deliveryAttempts: Number(row.delivery_attempts),
  }
}
