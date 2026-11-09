import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { AUDIT_PAGE_MAX, IAuditEvent, IAuditQuery, TNewAuditEvent } from '@domain/models/Audit.Model'
import { IAuditRepository } from '@domain/ports/AuditRepository.Port'

/** ⚖️ Só acrescenta: nenhuma rota apaga nem edita um evento. Os índices servem a tela (por data, por quem). */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    at               TEXT NOT NULL,
    actor_id         TEXT,
    actor_email      TEXT,
    agent_id         TEXT,
    conversation_id  TEXT,
    action           TEXT NOT NULL,
    target           TEXT,
    status           INTEGER NOT NULL,
    duration_ms      INTEGER,
    ip               TEXT,
    detail           TEXT
  );
  CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);
  CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events (actor_id);
`

type TRow = Record<string, unknown>

/** Os eventos de auditoria, no mesmo arquivo das conversas. */
export class SqliteAuditRepository implements IAuditRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  append(event: TNewAuditEvent): void {
    try {
      this.db
        .prepare(
          'INSERT INTO audit_events (at, actor_id, actor_email, agent_id, conversation_id, action, target, status, duration_ms, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          event.at.toISOString(),
          event.actorId ?? null,
          event.actorEmail ?? null,
          event.agentId ?? null,
          event.conversationId ?? null,
          event.action,
          event.target && Object.keys(event.target).length ? JSON.stringify(event.target) : null,
          event.status,
          event.durationMs ?? null,
          event.ip ?? null,
          event.detail ?? null,
        )
    } catch (error) {
      // ⚖️ Perder um evento é melhor que derrubar a rota que ele descreve.
      console.error('[auditoria] não gravou o evento:', error instanceof Error ? error.message : error)
    }
  }

  query(filter: IAuditQuery): IAuditEvent[] {
    const where: string[] = []
    const values: SQLInputValue[] = []
    const add = (clause: string, ...params: SQLInputValue[]) => {
      where.push(clause)
      values.push(...params)
    }
    if (filter.since) add('at >= ?', filter.since.toISOString())
    if (filter.until) add('at < ?', filter.until.toISOString())
    if (filter.actor) add("(actor_id LIKE ? ESCAPE '\\' OR actor_email LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')", ...Array<string>(3).fill(like(filter.actor)))
    if (filter.action) add("action LIKE ? ESCAPE '\\'", like(filter.action))
    if (filter.failed) add('status >= 400')
    if (filter.before) add('id < ?', filter.before)
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), AUDIT_PAGE_MAX)
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...values, limit) as TRow[]).map(toEvent)
  }
}

/** O texto vira `%texto%`, com `%`, `_` e `\` tratados como letra. */
function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

function toEvent(row: TRow): IAuditEvent {
  const target = text(row.target)
  return {
    id: Number(row.id),
    at: new Date(String(row.at)),
    ...(text(row.actor_id) ? { actorId: text(row.actor_id) } : {}),
    ...(text(row.actor_email) ? { actorEmail: text(row.actor_email) } : {}),
    ...(text(row.agent_id) ? { agentId: text(row.agent_id) } : {}),
    ...(text(row.conversation_id) ? { conversationId: text(row.conversation_id) } : {}),
    action: String(row.action),
    ...(target ? { target: JSON.parse(target) as Record<string, string> } : {}),
    status: Number(row.status),
    ...(typeof row.duration_ms === 'number' ? { durationMs: row.duration_ms } : {}),
    ...(text(row.ip) ? { ip: text(row.ip) } : {}),
    ...(text(row.detail) ? { detail: text(row.detail) } : {}),
  }
}
