import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IResourceSecretMeta, secretOwner, TSecretScope } from '@domain/models/ResourceSecret.Model'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS resource_secrets (
    scope        TEXT NOT NULL,
    scope_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    sealed       TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    updated_by   TEXT,
    PRIMARY KEY (scope, scope_id, name)
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
    this.db.exec(SCHEMA)
  }

  list(scope: TSecretScope, scopeId: string): IResourceSecretMeta[] {
    return (
      this.db
        .prepare('SELECT scope, scope_id, name, description, updated_at, updated_by FROM resource_secrets WHERE scope = ? AND scope_id = ? ORDER BY name')
        .all(scope, scopeId) as TRow[]
    ).map(toMeta)
  }

  /** O valor aberto, ou `undefined` (não existe, ou o cofre não abre — chave trocada, cifrado adulterado). */
  value(scope: TSecretScope, scopeId: string, name: string): string | undefined {
    const row = this.db.prepare('SELECT sealed FROM resource_secrets WHERE scope = ? AND scope_id = ? AND name = ?').get(scope, scopeId, name) as TRow | undefined
    return row ? this.box.open(String(row.sealed), secretOwner(scope, scopeId, name)) : undefined
  }

  /** Grava a variável. Sem `value`, só a descrição muda (a variável tem de existir). Devolve se gravou. */
  save(input: { scope: TSecretScope; scopeId: string; name: string; description?: string; value?: string; by: string; at: Date }): boolean {
    const description = input.description?.trim() || null
    if (input.value === undefined) {
      const result = this.db
        .prepare('UPDATE resource_secrets SET description = ?, updated_at = ?, updated_by = ? WHERE scope = ? AND scope_id = ? AND name = ?')
        .run(description, input.at.toISOString(), input.by, input.scope, input.scopeId, input.name)
      return Number(result.changes) === 1
    }
    this.db
      .prepare(
        `INSERT INTO resource_secrets (scope, scope_id, name, description, sealed, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id, name) DO UPDATE SET description = excluded.description, sealed = excluded.sealed, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(input.scope, input.scopeId, input.name, description, this.box.seal(input.value, secretOwner(input.scope, input.scopeId, input.name)), input.at.toISOString(), input.by)
    return true
  }

  remove(scope: TSecretScope, scopeId: string, name: string): boolean {
    return Number(this.db.prepare('DELETE FROM resource_secrets WHERE scope = ? AND scope_id = ? AND name = ?').run(scope, scopeId, name).changes) === 1
  }

  /** O recurso foi apagado: as variáveis dele vão junto. */
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
