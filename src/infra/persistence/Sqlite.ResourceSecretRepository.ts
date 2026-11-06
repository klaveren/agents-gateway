import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IResourceSecretMeta, ORIGIN_PROJECT, secretOwner, TSecretScope } from '@domain/models/ResourceSecret.Model'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS resource_secrets (
    scope        TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    project      TEXT NOT NULL DEFAULT '',
    name         TEXT NOT NULL,
    description  TEXT,
    sealed       TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT,
    PRIMARY KEY (scope, scope_id, project, name)
  );
`

type TRow = Record<string, unknown>

/**
 * As variáveis secretas dos recursos (ver `ResourceSecret.Model`), no mesmo arquivo das conversas. ⛔ O valor só entra
 * cifrado (`sealed`, AAD = o recurso e o nome) e só sai por `value`, que o servidor usa para montar o ambiente do processo.
 */
export class SqliteResourceSecretRepository {
  private readonly db: DatabaseSync

  constructor(
    private readonly box: SecretBox,
    path = ':memory:',
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
    this.db.exec(SCHEMA)
  }

  /** ⚖️ Banco de antes dos projetos: as variáveis de hoje viram as da ORIGEM (`project = ''`), sem perder nenhuma (o cifrado segue o mesmo). */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info('resource_secrets')").all() as TRow[]
    if (!columns.length || columns.some((column) => column.name === 'project')) return
    this.db.exec('BEGIN')
    try {
      this.db.exec('ALTER TABLE resource_secrets RENAME TO resource_secrets_antes')
      this.db.exec(SCHEMA)
      this.db.exec(
        `INSERT INTO resource_secrets (scope, scope_id, project, name, description, sealed, updated_at, updated_by)
         SELECT scope, scope_id, '', name, description, sealed, updated_at, updated_by FROM resource_secrets_antes`,
      )
      this.db.exec('DROP TABLE resource_secrets_antes')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  list(scope: TSecretScope, scopeId: string, project: string = ORIGIN_PROJECT): IResourceSecretMeta[] {
    return (
      this.db
        .prepare('SELECT scope, scope_id, name, description, updated_at, updated_by FROM resource_secrets WHERE scope = ? AND scope_id = ? AND project = ? ORDER BY name')
        .all(scope, scopeId, project) as TRow[]
    ).map(toMeta)
  }

  /** O valor aberto, ou `undefined` (não existe, ou o cofre não abre — chave trocada, cifrado adulterado). */
  value(scope: TSecretScope, scopeId: string, name: string, project: string = ORIGIN_PROJECT): string | undefined {
    const row = this.db.prepare('SELECT sealed FROM resource_secrets WHERE scope = ? AND scope_id = ? AND project = ? AND name = ?').get(scope, scopeId, project, name) as
      TRow | undefined
    return row ? this.box.open(String(row.sealed), secretOwner(scope, scopeId, name, project)) : undefined
  }

  /** Grava a variável. Sem `value`, só a descrição muda (a variável tem de existir). Devolve se gravou. */
  save(input: { scope: TSecretScope; scopeId: string; project?: string; name: string; description?: string; value?: string; by: string; at: Date }): boolean {
    const description = input.description?.trim() || null
    const project = input.project ?? ORIGIN_PROJECT
    if (input.value === undefined) {
      const result = this.db
        .prepare('UPDATE resource_secrets SET description = ?, updated_at = ?, updated_by = ? WHERE scope = ? AND scope_id = ? AND project = ? AND name = ?')
        .run(description, input.at.toISOString(), input.by, input.scope, input.scopeId, project, input.name)
      return Number(result.changes) === 1
    }
    this.db
      .prepare(
        `INSERT INTO resource_secrets (scope, scope_id, project, name, description, sealed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id, project, name) DO UPDATE SET description = excluded.description, sealed = excluded.sealed, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        input.scope,
        input.scopeId,
        project,
        input.name,
        description,
        this.box.seal(input.value, secretOwner(input.scope, input.scopeId, input.name, project)),
        input.at.toISOString(),
        input.by,
      )
    return true
  }

  remove(scope: TSecretScope, scopeId: string, name: string, project: string = ORIGIN_PROJECT): boolean {
    return Number(this.db.prepare('DELETE FROM resource_secrets WHERE scope = ? AND scope_id = ? AND project = ? AND name = ?').run(scope, scopeId, project, name).changes) === 1
  }

  /** ⛔ Só ficam os valores da origem e dos projetos em `keep`: quem deixou de receber o recurso perde os valores dele. */
  keepProjects(scope: TSecretScope, scopeId: string, keep: readonly string[]): void {
    const rows = this.db.prepare("SELECT DISTINCT project FROM resource_secrets WHERE scope = ? AND scope_id = ? AND project <> ''").all(scope, scopeId) as TRow[]
    for (const row of rows) {
      const project = String(row.project)
      if (!keep.includes(project)) this.db.prepare('DELETE FROM resource_secrets WHERE scope = ? AND scope_id = ? AND project = ?').run(scope, scopeId, project)
    }
  }

  /** O projeto foi apagado: os valores que ele configurou para recursos de outros vão junto. */
  removeProject(project: string): void {
    if (project !== ORIGIN_PROJECT) this.db.prepare('DELETE FROM resource_secrets WHERE project = ?').run(project)
  }

  /** O recurso foi apagado: as variáveis dele vão junto (as da origem e as de cada projeto). */
  removeScope(scope: TSecretScope, scopeId: string): void {
    this.db.prepare('DELETE FROM resource_secrets WHERE scope = ? AND scope_id = ?').run(scope, scopeId)
  }
}

function toMeta(row: TRow): IResourceSecretMeta {
  return {
    scope: String(row.scope) as TSecretScope,
    scopeId: String(row.scope_id),
    name: String(row.name),
    ...(typeof row.description === 'string' && row.description ? { description: row.description } : {}),
    updatedAt: new Date(String(row.updated_at)),
    ...(typeof row.updated_by === 'string' ? { updatedBy: row.updated_by } : {}),
  }
}
