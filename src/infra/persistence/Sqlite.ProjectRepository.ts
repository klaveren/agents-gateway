import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IAgenticScope, normalizeScope } from '@domain/Import.Scope'
import { IProject, IProjectMcpVar, IProjectMember, TProjectRole } from '@domain/models/Project.Model'
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

/**
 * Colunas que entraram depois da tabela: o banco antigo ganha a coluna na abertura. SQLite não tem
 * `ADD COLUMN IF NOT EXISTS`, por isso a checagem em `PRAGMA table_info`.
 */
const ADDED_COLUMNS: ReadonlyArray<{ column: string; definition: string }> = [
  // JSON com a lista de globs; NULL = nenhum.
  { column: 'import_ignore', definition: 'TEXT' },
  // JSON `{ disabled, extra }`; NULL = os lugares padrão, todos ligados.
  { column: 'import_scope', definition: 'TEXT' },
  // JSON `{ NOME: valor }` (as variáveis fixas); NULL = nenhuma.
  { column: 'env', definition: 'TEXT' },
  // JSON `[{ server, name, value }]` (os valores visíveis dos MCPs); NULL = nenhum.
  { column: 'mcp_env', definition: 'TEXT' },
]

/** Os projetos e os membros, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteProjectRepository implements IProjectRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const existing = this.db.prepare('PRAGMA table_info(projects)').all() as TRow[]
    for (const { column, definition } of ADDED_COLUMNS) {
      if (!existing.some((row) => row.name === column)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${column} ${definition}`)
    }
    // O papel no projeto entrou depois: o membro antigo nasce `member` (a migração dos papéis promove os administradores).
    const memberColumns = this.db.prepare('PRAGMA table_info(project_members)').all() as TRow[]
    if (!memberColumns.some((row) => row.name === 'role')) this.db.exec(`ALTER TABLE project_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`)
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

  update(id: string, patch: Partial<Pick<IProject, 'name' | 'description' | 'importIgnore' | 'importScope' | 'env' | 'mcpEnv' | 'updatedAt' | 'updatedBy'>>): IProject | undefined {
    if (patch.name !== undefined) this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(patch.name, id)
    if ('description' in patch) this.db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(patch.description ?? null, id)
    if ('importIgnore' in patch)
      this.db.prepare('UPDATE projects SET import_ignore = ? WHERE id = ?').run(patch.importIgnore?.length ? JSON.stringify(patch.importIgnore) : null, id)
    if ('importScope' in patch) {
      const scope = patch.importScope
      this.db.prepare('UPDATE projects SET import_scope = ? WHERE id = ?').run(scope && (scope.disabled.length || scope.extra.length) ? JSON.stringify(scope) : null, id)
    }
    if ('env' in patch) this.db.prepare('UPDATE projects SET env = ? WHERE id = ?').run(patch.env && Object.keys(patch.env).length ? JSON.stringify(patch.env) : null, id)
    if ('mcpEnv' in patch) this.db.prepare('UPDATE projects SET mcp_env = ? WHERE id = ?').run(patch.mcpEnv?.length ? JSON.stringify(patch.mcpEnv) : null, id)
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
      role: row.role === 'admin' ? 'admin' : 'member',
      addedAt: new Date(String(row.added_at)),
      ...(typeof row.added_by === 'string' ? { addedBy: row.added_by } : {}),
    }))
  }

  projectsOf(userId: string): string[] {
    return (this.db.prepare('SELECT project_id FROM project_members WHERE user_id = ?').all(userId) as TRow[]).map((row) => String(row.project_id))
  }

  /** ⚖️ Quem continua fica com a data de entrada que tinha (e o papel novo); quem sai, sai; quem entra, entra agora. */
  setMembers(projectId: string, members: ReadonlyArray<{ userId: string; role: TProjectRole }>, by: string): void {
    const wanted = new Map(members.map((member) => [member.userId, member.role]))
    const current = new Set(this.members(projectId).map((member) => member.userId))
    const now = new Date().toISOString()
    for (const userId of current) if (!wanted.has(userId)) this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId)
    for (const [userId, role] of wanted)
      if (current.has(userId)) this.db.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, projectId, userId)
      else this.db.prepare('INSERT INTO project_members (project_id, user_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)').run(projectId, userId, role, now, by)
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
    ...(importIgnoreOf(row.import_ignore).length ? { importIgnore: importIgnoreOf(row.import_ignore) } : {}),
    ...(importScopeOf(row.import_scope) ? { importScope: importScopeOf(row.import_scope) } : {}),
    ...(envOf(row.env) ? { env: envOf(row.env) } : {}),
    ...(mcpEnvOf(row.mcp_env).length ? { mcpEnv: mcpEnvOf(row.mcp_env) } : {}),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}

function envOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const entries = Object.entries(parsed ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    return entries.length ? Object.fromEntries(entries) : undefined
  } catch {
    return undefined
  }
}

function mcpEnvOf(value: unknown): IProjectMcpVar[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is IProjectMcpVar => !!item && typeof item.server === 'string' && typeof item.name === 'string' && typeof item.value === 'string')
      : []
  } catch {
    return []
  }
}

function importScopeOf(value: unknown): IAgenticScope | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const parsed = JSON.parse(value) as { disabled?: unknown; extra?: unknown }
    const strings = (list: unknown) => (Array.isArray(list) ? list.filter((one): one is string => typeof one === 'string') : [])
    return normalizeScope({ disabled: strings(parsed.disabled), extra: strings(parsed.extra) })
  } catch {
    return undefined
  }
}

function importIgnoreOf(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((pattern): pattern is string => typeof pattern === 'string') : []
  } catch {
    return []
  }
}
