import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IPermissionRequest, IPermissionRequester, IPermissionWidening, TPermissionRequestKind, TStoredPermissionRequestStatus } from '@domain/models/PermissionRequest.Model'
import { IPermissionRule } from '@domain/Permission.Policy'
import { IPermissionRequestDecision, IPermissionRequestFilter, IPermissionRequestRepository } from '@domain/ports/PermissionRequestRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS permission_requests (
    id            TEXT NOT NULL PRIMARY KEY,
    kind          TEXT NOT NULL,
    agent_id      TEXT,
    project_id    TEXT,
    add_rules     TEXT NOT NULL,
    remove_rules  TEXT NOT NULL,
    patch         TEXT,
    widenings     TEXT NOT NULL,
    reason        TEXT NOT NULL,
    requested_by  TEXT NOT NULL,
    base_hash     TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    decided_by    TEXT,
    decided_at    TEXT,
    decision_note TEXT
  );
  CREATE INDEX IF NOT EXISTS permission_requests_agent ON permission_requests (agent_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS permission_requests_project ON permission_requests (project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS permission_requests_status ON permission_requests (status, created_at DESC);
`

/** As colunas que vieram depois da tabela: um banco antigo as ganha ao abrir (vazias = o pedido de antes, um lote só). */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['entries', 'TEXT'],
  ['batch_id', 'TEXT'],
]

type TRow = Record<string, unknown>

/** Os pedidos de permissão, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqlitePermissionRequestRepository implements IPermissionRequestRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const columns = new Set((this.db.prepare('PRAGMA table_info(permission_requests)').all() as TRow[]).map((row) => row.name as string))
    for (const [name, type] of ADDED_COLUMNS) if (!columns.has(name)) this.db.exec(`ALTER TABLE permission_requests ADD COLUMN ${name} ${type}`)
  }

  create(request: IPermissionRequest): void {
    this.db
      .prepare(
        `INSERT INTO permission_requests (id, kind, agent_id, project_id, add_rules, remove_rules, patch, entries, batch_id, widenings, reason, requested_by, base_hash, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.kind,
        request.agentId ?? null,
        request.projectId ?? null,
        JSON.stringify(request.add),
        JSON.stringify(request.remove),
        request.patch ? JSON.stringify(request.patch) : null,
        request.entries ? JSON.stringify(request.entries) : null,
        request.batchId ?? null,
        JSON.stringify(request.widenings),
        request.reason,
        JSON.stringify(request.requestedBy),
        request.baseHash,
        request.createdAt.toISOString(),
        request.status,
      )
  }

  get(id: string): IPermissionRequest | undefined {
    const row = this.db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as TRow | undefined
    return row ? toRequest(row) : undefined
  }

  list(filter: IPermissionRequestFilter = {}): IPermissionRequest[] {
    const where: string[] = []
    const args: Array<string | number> = []
    if (filter.agentId) {
      where.push('agent_id = ?')
      args.push(filter.agentId)
    }
    if (filter.projectId) {
      where.push('project_id = ?')
      args.push(filter.projectId)
    }
    if (filter.kind) {
      where.push('kind = ?')
      args.push(filter.kind)
    }
    if (filter.open) where.push(`status = 'pending'`)
    const sql = `SELECT * FROM permission_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`
    return (this.db.prepare(sql).all(...args, filter.limit ?? 200) as TRow[]).map(toRequest)
  }

  decide(id: string, decision: IPermissionRequestDecision): boolean {
    const result = this.db
      .prepare(`UPDATE permission_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'`)
      .run(decision.status, decision.by, decision.at.toISOString(), decision.note ?? null, id)
    return Number(result.changes) === 1
  }
}

function toRequest(row: TRow): IPermissionRequest {
  return {
    id: String(row.id),
    kind: String(row.kind) as TPermissionRequestKind,
    ...(typeof row.agent_id === 'string' && row.agent_id ? { agentId: row.agent_id } : {}),
    ...(typeof row.project_id === 'string' && row.project_id ? { projectId: row.project_id } : {}),
    add: JSON.parse(String(row.add_rules)) as IPermissionRule[],
    remove: JSON.parse(String(row.remove_rules)) as IPermissionRule[],
    ...(typeof row.patch === 'string' ? { patch: JSON.parse(row.patch) as Record<string, unknown> } : {}),
    ...(typeof row.entries === 'string' ? { entries: JSON.parse(row.entries) as { field: string; add: string[] } } : {}),
    ...(typeof row.batch_id === 'string' && row.batch_id ? { batchId: row.batch_id } : {}),
    widenings: JSON.parse(String(row.widenings)) as IPermissionWidening[],
    reason: String(row.reason),
    requestedBy: JSON.parse(String(row.requested_by)) as IPermissionRequester,
    baseHash: String(row.base_hash),
    createdAt: new Date(String(row.created_at)),
    status: String(row.status) as TStoredPermissionRequestStatus,
    ...(typeof row.decided_by === 'string' ? { decidedBy: row.decided_by } : {}),
    ...(typeof row.decided_at === 'string' ? { decidedAt: new Date(row.decided_at) } : {}),
    ...(typeof row.decision_note === 'string' ? { decisionNote: row.decision_note } : {}),
  }
}
