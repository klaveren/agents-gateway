import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ILedgerContext, ILedgerLine, ILedgerRevision, TLedgerAction, TLedgerAuthor, TLedgerLineType, TLedgerSnapshot } from '@domain/models/Ledger.Model'
import { ILedgerRepository, TLedgerContextChange, TLedgerLineChange, TNewLedgerContext, TNewLedgerLine } from '@domain/ports/LedgerRepository.Port'

/**
 * ⚖️ Por AGENTE (`agent_id`), sem chave estrangeira para o catálogo: apagar o agente NÃO apaga o ledger. Restaurar o
 * agente pelo histórico do catálogo (ou recriá-lo com o mesmo id) devolve a memória dele; o aprendizado não se perde
 * por um clique. Quem quer limpar exclui os contextos na guia Memória.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger_contexts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    topic       TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    playbook    TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL,
    UNIQUE (agent_id, topic)
  );
  CREATE TABLE IF NOT EXISTS ledger_lines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    context_id  INTEGER NOT NULL REFERENCES ledger_contexts(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    type        TEXT NOT NULL,
    trigger     TEXT NOT NULL,
    learning    TEXT NOT NULL,
    ref         TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    created_by  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_lines_context ON ledger_lines (context_id, id);
  CREATE TABLE IF NOT EXISTS ledger_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL,
    topic       TEXT NOT NULL,
    action      TEXT NOT NULL,
    line_id     INTEGER,
    at          TEXT NOT NULL,
    by          TEXT NOT NULL,
    before      TEXT,
    after       TEXT
  );
  CREATE INDEX IF NOT EXISTS ledger_revisions_topic ON ledger_revisions (agent_id, topic, id DESC);
`

type TRow = Record<string, unknown>

/** O ledger dos agentes, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteLedgerRepository implements ILedgerRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
  }

  contexts(agentId: string): ILedgerContext[] {
    return (this.db.prepare('SELECT * FROM ledger_contexts WHERE agent_id = ? ORDER BY topic').all(agentId) as TRow[]).map(toContext)
  }

  context(agentId: string, topic: string): ILedgerContext | undefined {
    const row = this.db.prepare('SELECT * FROM ledger_contexts WHERE agent_id = ? AND topic = ?').get(agentId, topic) as TRow | undefined
    return row ? toContext(row) : undefined
  }

  lines(contextId: number): ILedgerLine[] {
    return (this.db.prepare('SELECT * FROM ledger_lines WHERE context_id = ? ORDER BY id').all(contextId) as TRow[]).map(toLine)
  }

  agentLines(agentId: string): Array<ILedgerLine & { topic: string }> {
    const rows = this.db
      .prepare('SELECT l.*, c.topic AS topic FROM ledger_lines l JOIN ledger_contexts c ON c.id = l.context_id WHERE c.agent_id = ? ORDER BY c.topic, l.id')
      .all(agentId) as TRow[]
    return rows.map((row) => ({ ...toLine(row), topic: String(row.topic) }))
  }

  createContext(context: TNewLedgerContext): ILedgerContext {
    const result = this.db
      .prepare('INSERT INTO ledger_contexts (agent_id, topic, trigger, playbook, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        context.agentId,
        context.topic,
        context.trigger,
        context.playbook,
        context.createdAt.toISOString(),
        JSON.stringify(context.createdBy),
        context.updatedAt.toISOString(),
        JSON.stringify(context.updatedBy),
      )
    return { ...context, id: Number(result.lastInsertRowid) }
  }

  updateContext(id: number, change: TLedgerContextChange): void {
    const sets = ['updated_at = ?', 'updated_by = ?']
    const args: string[] = [change.updatedAt.toISOString(), JSON.stringify(change.updatedBy)]
    for (const field of ['trigger', 'playbook'] as const)
      if (change[field] !== undefined) {
        sets.push(`${field} = ?`)
        args.push(change[field])
      }
    this.db.prepare(`UPDATE ledger_contexts SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  }

  deleteContext(id: number): void {
    this.db.prepare('DELETE FROM ledger_lines WHERE context_id = ?').run(id)
    this.db.prepare('DELETE FROM ledger_contexts WHERE id = ?').run(id)
  }

  addLine(line: TNewLedgerLine): ILedgerLine {
    const result = this.db
      .prepare('INSERT INTO ledger_lines (context_id, date, type, trigger, learning, ref, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        line.contextId,
        line.date,
        line.type,
        line.trigger,
        line.learning,
        line.ref,
        line.createdAt.toISOString(),
        JSON.stringify(line.createdBy),
        line.updatedAt.toISOString(),
        JSON.stringify(line.updatedBy),
      )
    return { ...line, id: Number(result.lastInsertRowid) }
  }

  updateLine(id: number, change: TLedgerLineChange): void {
    const sets = ['updated_at = ?', 'updated_by = ?']
    const args: string[] = [change.updatedAt.toISOString(), JSON.stringify(change.updatedBy)]
    for (const field of ['date', 'type', 'trigger', 'learning', 'ref'] as const)
      if (change[field] !== undefined) {
        sets.push(`${field} = ?`)
        args.push(change[field])
      }
    this.db.prepare(`UPDATE ledger_lines SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
  }

  deleteLine(id: number): void {
    this.db.prepare('DELETE FROM ledger_lines WHERE id = ?').run(id)
  }

  addRevision(revision: Omit<ILedgerRevision, 'id'>): void {
    this.db
      .prepare('INSERT INTO ledger_revisions (agent_id, topic, action, line_id, at, by, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        revision.agentId,
        revision.topic,
        revision.action,
        revision.lineId ?? null,
        revision.at.toISOString(),
        JSON.stringify(revision.by),
        revision.before ? JSON.stringify(revision.before) : null,
        revision.after ? JSON.stringify(revision.after) : null,
      )
  }

  revisions(agentId: string, topic: string, limit = 200): ILedgerRevision[] {
    const rows = this.db.prepare('SELECT * FROM ledger_revisions WHERE agent_id = ? AND topic = ? ORDER BY id DESC LIMIT ?').all(agentId, topic, limit) as TRow[]
    return rows.map((row) => ({
      id: Number(row.id),
      agentId: String(row.agent_id),
      topic: String(row.topic),
      action: String(row.action) as TLedgerAction,
      ...(row.line_id === null || row.line_id === undefined ? {} : { lineId: Number(row.line_id) }),
      at: new Date(String(row.at)),
      by: JSON.parse(String(row.by)) as TLedgerAuthor,
      ...(typeof row.before === 'string' ? { before: JSON.parse(row.before) as TLedgerSnapshot } : {}),
      ...(typeof row.after === 'string' ? { after: JSON.parse(row.after) as TLedgerSnapshot } : {}),
    }))
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function toContext(row: TRow): ILedgerContext {
  return {
    id: Number(row.id),
    agentId: String(row.agent_id),
    topic: String(row.topic),
    trigger: String(row.trigger),
    playbook: String(row.playbook ?? ''),
    createdAt: new Date(String(row.created_at)),
    createdBy: JSON.parse(String(row.created_by)) as TLedgerAuthor,
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: JSON.parse(String(row.updated_by)) as TLedgerAuthor,
  }
}

function toLine(row: TRow): ILedgerLine {
  return {
    id: Number(row.id),
    contextId: Number(row.context_id),
    date: String(row.date),
    type: String(row.type) as TLedgerLineType,
    trigger: String(row.trigger),
    learning: String(row.learning),
    ref: String(row.ref ?? ''),
    createdAt: new Date(String(row.created_at)),
    createdBy: JSON.parse(String(row.created_by)) as TLedgerAuthor,
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: JSON.parse(String(row.updated_by)) as TLedgerAuthor,
  }
}
