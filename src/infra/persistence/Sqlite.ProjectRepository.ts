import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IProject, IProjectMember } from '@domain/models/Project.Model'
import { IProjectRepository } from '@domain/ports/ProjectRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id           TEXT NOT NULL PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT
  );
  CREATE TABLE IF NOT EXISTS project_members (
    project_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    added_at    TEXT NOT NULL,
    added_by    TEXT,
    PRIMARY KEY (project_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id);
  CREATE TABLE IF NOT EXISTS project_meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  );
`

type TRow = Record<string, unknown>

/** Os projetos e os membros, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteProjectRepository implements IProjectRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(): IProject[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE ASC, id ASC').all() as TRow[]).map(toProject)
  }

  get(id: string): IProject | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as TRow | undefined
    return row ? toProject(row) : undefined
  }

  insert(project: IProject): void {
    this.db
      .prepare('INSERT INTO projects (id, name, description, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(project.id, project.name, project.description ?? null, project.createdAt.toISOString(), project.updatedAt.toISOString(), project.updatedBy ?? null)
  }

  update(id: string, patch: Partial<Pick<IProject, 'name' | 'description' | 'updatedAt' | 'updatedBy'>>): IProject | undefined {
    if (patch.name !== undefined) this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(patch.name, id)
    if ('description' in patch) this.db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(patch.description ?? null, id)
    if (patch.updatedAt) this.db.prepare('UPDATE projects SET updated_at = ?, updated_by = ? WHERE id = ?').run(patch.updatedAt.toISOString(), patch.updatedBy ?? null, id)
    return this.get(id)
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0
  }

  members(projectId: string): IProjectMember[] {
    return (this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY added_at ASC').all(projectId) as TRow[]).map((row) => ({
      projectId: String(row.project_id),
      userId: String(row.user_id),
      addedAt: new Date(String(row.added_at)),
      ...(typeof row.added_by === 'string' ? { addedBy: row.added_by } : {}),
    }))
  }

  projectsOf(userId: string): string[] {
    return (this.db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(userId) as TRow[]).map((row) => String(row.project_id))
  }

  /** ⚖️ Quem continua fica com a data de entrada que tinha; quem sai, sai; quem entra, entra agora. */
  setMembers(projectId: string, userIds: readonly string[], by: string): void {
    const wanted = new Set(userIds)
    const current = new Set(this.members(projectId).map((member) => member.userId))
    const now = new Date().toISOString()
    for (const userId of current) if (!wanted.has(userId)) this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId)
    for (const userId of wanted)
      if (!current.has(userId)) this.db.prepare('INSERT INTO project_members (project_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)').run(projectId, userId, now, by)
  }

  done(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM project_meta WHERE key = ?').get(key)
  }

  markDone(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO project_meta (key, value) VALUES (?, ?)').run(key, new Date().toISOString())
  }
}

function toProject(row: TRow): IProject {
  return {
    id: String(row.id),
    name: String(row.name),
    ...(typeof row.description === 'string' && row.description ? { description: row.description } : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}
