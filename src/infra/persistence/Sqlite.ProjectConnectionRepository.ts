import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IProjectConnection } from '@domain/models/ProjectConnection.Model'
import { ILedgerOutboxEntry, IProjectConnectionRepository, TConnectionPatch } from '@domain/ports/ProjectConnectionRepository.Port'

/** ⛔ O token da conexão fica SELADO (`SecretBox`, dono `connect:<projeto>`): com o banco nas mãos, ninguém o usa. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_connections (
    project_id         TEXT NOT NULL PRIMARY KEY,
    url                TEXT NOT NULL,
    remote_project_id  TEXT NOT NULL,
    token_sealed       TEXT NOT NULL,
    synced_version     INTEGER NOT NULL DEFAULT 0,
    latest_version     INTEGER NOT NULL DEFAULT 0,
    state              TEXT NOT NULL DEFAULT 'ok',
    last_error         TEXT,
    changes            TEXT NOT NULL DEFAULT '[]',
    changes_truncated  INTEGER NOT NULL DEFAULT 0,
    skipped            TEXT NOT NULL DEFAULT '[]',
    secrets            TEXT NOT NULL DEFAULT '[]',
    model_map          TEXT NOT NULL DEFAULT '{}',
    created_at         TEXT NOT NULL,
    created_by         TEXT NOT NULL,
    last_checked_at    TEXT,
    last_synced_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS ledger_outbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    change           TEXT NOT NULL,
    conversation_id  TEXT,
    created_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ledger_outbox_project ON ledger_outbox (project_id, id);
`

type TRow = Record<string, unknown>

/** As conexões dos projetos conectados, no mesmo arquivo das conversas. */
export class SqliteProjectConnectionRepository implements IProjectConnectionRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const columns = this.db.prepare('PRAGMA table_info(project_connections)').all() as TRow[]
    if (!columns.some((column) => column.name === 'usage_sent_at')) this.db.exec('ALTER TABLE project_connections ADD COLUMN usage_sent_at TEXT')
  }

  insert(connection: IProjectConnection, tokenSealed: string): void {
    this.db
      .prepare('INSERT INTO project_connections (project_id, url, remote_project_id, token_sealed, created_at, created_by, model_map) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        connection.projectId,
        connection.url,
        connection.remoteProjectId,
        tokenSealed,
        connection.createdAt.toISOString(),
        connection.createdBy,
        JSON.stringify(connection.modelMap),
      )
  }

  get(projectId: string): IProjectConnection | undefined {
    const row = this.db.prepare('SELECT * FROM project_connections WHERE project_id = ?').get(projectId) as TRow | undefined
    return row ? toConnection(row) : undefined
  }

  list(): IProjectConnection[] {
    return (this.db.prepare('SELECT * FROM project_connections ORDER BY project_id').all() as TRow[]).map(toConnection)
  }

  tokenSealed(projectId: string): string | undefined {
    const row = this.db.prepare('SELECT token_sealed FROM project_connections WHERE project_id = ?').get(projectId) as TRow | undefined
    return row ? String(row.token_sealed) : undefined
  }

  update(projectId: string, patch: TConnectionPatch): void {
    const columns: Array<[string, string | number | null]> = []
    const set = (column: string, value: string | number | null | undefined) => {
      if (value !== undefined) columns.push([column, value])
    }
    set('url', patch.url)
    set('token_sealed', patch.tokenSealed)
    set('synced_version', patch.syncedVersion)
    set('latest_version', patch.latestVersion)
    set('state', patch.state)
    if ('lastError' in patch) columns.push(['last_error', patch.lastError ?? null])
    set('changes', patch.changes && JSON.stringify(patch.changes))
    if ('changesTruncated' in patch) columns.push(['changes_truncated', patch.changesTruncated ? 1 : 0])
    set('skipped', patch.skipped && JSON.stringify(patch.skipped))
    set('secrets', patch.secrets && JSON.stringify(patch.secrets))
    set('model_map', patch.modelMap && JSON.stringify(patch.modelMap))
    set('last_checked_at', patch.lastCheckedAt?.toISOString())
    set('last_synced_at', patch.lastSyncedAt?.toISOString())
    set('usage_sent_at', patch.usageSentAt?.toISOString())
    if (!columns.length) return
    this.db
      .prepare(`UPDATE project_connections SET ${columns.map(([column]) => `${column} = ?`).join(', ')} WHERE project_id = ?`)
      .run(...columns.map(([, value]) => value), projectId)
  }

  remove(projectId: string): void {
    this.db.prepare('DELETE FROM project_connections WHERE project_id = ?').run(projectId)
    this.db.prepare('DELETE FROM ledger_outbox WHERE project_id = ?').run(projectId)
  }

  enqueueLedger(entry: Omit<ILedgerOutboxEntry, 'id'>): void {
    this.db
      .prepare('INSERT INTO ledger_outbox (project_id, agent_id, change, conversation_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entry.projectId, entry.agentId, JSON.stringify(entry.change), entry.conversationId ?? null, entry.createdAt.toISOString())
  }

  pendingLedger(projectId: string): ILedgerOutboxEntry[] {
    return (this.db.prepare('SELECT * FROM ledger_outbox WHERE project_id = ? ORDER BY id').all(projectId) as TRow[]).map((row) => ({
      id: Number(row.id),
      projectId: String(row.project_id),
      agentId: String(row.agent_id),
      change: JSON.parse(String(row.change)),
      ...(typeof row.conversation_id === 'string' ? { conversationId: row.conversation_id } : {}),
      createdAt: new Date(String(row.created_at)),
    }))
  }

  dropLedger(id: number): void {
    this.db.prepare('DELETE FROM ledger_outbox WHERE id = ?').run(id)
  }
}

const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : undefined)
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as T) : fallback
  } catch {
    return fallback
  }
}

function toConnection(row: TRow): IProjectConnection {
  const lastCheckedAt = date(row.last_checked_at)
  const lastSyncedAt = date(row.last_synced_at)
  const usageSentAt = date(row.usage_sent_at)
  return {
    projectId: String(row.project_id),
    url: String(row.url),
    remoteProjectId: String(row.remote_project_id),
    syncedVersion: Number(row.synced_version),
    latestVersion: Number(row.latest_version),
    state: String(row.state) as IProjectConnection['state'],
    ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
    changes: json(row.changes, []),
    ...(Number(row.changes_truncated) ? { changesTruncated: true } : {}),
    skipped: json(row.skipped, []),
    secrets: json(row.secrets, []),
    modelMap: json(row.model_map, {}),
    createdAt: new Date(String(row.created_at)),
    createdBy: String(row.created_by),
    ...(lastCheckedAt ? { lastCheckedAt } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
    ...(usageSentAt ? { usageSentAt } : {}),
  }
}
