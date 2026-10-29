import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IPermissionRule } from '@domain/Permission.Policy'
import { IPermissionDecision, IPermissionRepository, PERMISSION_DECISIONS_KEPT } from '@domain/ports/PermissionRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_permissions (
    project_id  TEXT NOT NULL PRIMARY KEY,
    rules       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );
  CREATE TABLE IF NOT EXISTS permission_decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    project_id  TEXT NOT NULL DEFAULT '',
    agent_id    TEXT,
    session_id  TEXT,
    category    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    allowed     INTEGER NOT NULL,
    layer       TEXT NOT NULL,
    pattern     TEXT
  );
  CREATE INDEX IF NOT EXISTS permission_decisions_project ON permission_decisions (project_id, id DESC);
`

type TRow = Record<string, unknown>

/** As permissões de cada projeto e o registro das decisões, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqlitePermissionRepository implements IPermissionRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  projectRules(projectId: string): { rules: IPermissionRule[]; updatedAt?: Date; updatedBy?: string } {
    const row = this.db.prepare('SELECT * FROM project_permissions WHERE project_id = ?').get(projectId) as TRow | undefined
    if (!row) return { rules: [] }
    return {
      rules: JSON.parse(String(row.rules)) as IPermissionRule[],
      updatedAt: new Date(String(row.updated_at)),
      ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
    }
  }

  saveProjectRules(projectId: string, rules: IPermissionRule[], by: string): void {
    this.db
      .prepare(
        `INSERT INTO project_permissions (project_id, rules, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(projectId, JSON.stringify(rules), new Date().toISOString(), by)
  }

  logDecision(decision: IPermissionDecision): void {
    const project = decision.projectId ?? ''
    this.db
      .prepare('INSERT INTO permission_decisions (at, project_id, agent_id, session_id, category, subject, allowed, layer, pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        decision.at.toISOString(),
        project,
        decision.agentId ?? null,
        decision.sessionId ?? null,
        decision.category,
        decision.subject.slice(0, 1000),
        decision.allowed ? 1 : 0,
        decision.layer,
        decision.pattern ?? null,
      )
    this.db
      .prepare('DELETE FROM permission_decisions WHERE project_id = ? AND id NOT IN (SELECT id FROM permission_decisions WHERE project_id = ? ORDER BY id DESC LIMIT ?)')
      .run(project, project, PERMISSION_DECISIONS_KEPT)
  }

  decisions(projectId: string, options: { agentId?: string; limit?: number } = {}): IPermissionDecision[] {
    const limit = Math.min(options.limit ?? 100, PERMISSION_DECISIONS_KEPT)
    const rows = (
      options.agentId
        ? this.db.prepare('SELECT * FROM permission_decisions WHERE project_id = ? AND agent_id = ? ORDER BY id DESC LIMIT ?').all(projectId, options.agentId, limit)
        : this.db.prepare('SELECT * FROM permission_decisions WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit)
    ) as TRow[]
    return rows.map((row) => ({
      at: new Date(String(row.at)),
      ...(row.project_id ? { projectId: String(row.project_id) } : {}),
      ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}),
      ...(typeof row.session_id === 'string' ? { sessionId: row.session_id } : {}),
      category: String(row.category) as IPermissionDecision['category'],
      subject: String(row.subject),
      allowed: Number(row.allowed) === 1,
      layer: String(row.layer) as IPermissionDecision['layer'],
      ...(typeof row.pattern === 'string' ? { pattern: row.pattern } : {}),
    }))
  }

  deleteProject(projectId: string): void {
    this.db.prepare('DELETE FROM project_permissions WHERE project_id = ?').run(projectId)
    this.db.prepare('DELETE FROM permission_decisions WHERE project_id = ?').run(projectId)
  }
}
