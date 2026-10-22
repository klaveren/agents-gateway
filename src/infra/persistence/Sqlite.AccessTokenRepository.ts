import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IStoredAccessToken } from '@domain/models/AccessToken.Model'
import { IAccessTokenRepository } from '@domain/ports/AccessTokenRepository.Port'

/** ⚖️ `token_hash` ÚNICO: é a chave da busca a cada requisição, e dois tokens iguais seriam a mesma porta. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS access_tokens (
    id            TEXT NOT NULL PRIMARY KEY,
    user_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    prefix        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT,
    last_used_at  TEXT,
    revoked_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS access_tokens_user ON access_tokens (user_id);
`

type TRow = Record<string, unknown>

/** Os tokens de acesso, no mesmo arquivo das contas. */
export class SqliteAccessTokenRepository implements IAccessTokenRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  insert(token: IStoredAccessToken): void {
    this.db
      .prepare('INSERT INTO access_tokens (id, user_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token.id, token.userId, token.name, token.tokenHash, token.prefix, token.createdAt.toISOString(), token.expiresAt?.toISOString() ?? null)
  }

  listByUser(userId: string): IStoredAccessToken[] {
    return (this.db.prepare('SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId) as TRow[]).map(toToken)
  }

  findByHash(tokenHash: string): IStoredAccessToken | undefined {
    const row = this.db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?').get(tokenHash) as TRow | undefined
    return row ? toToken(row) : undefined
  }

  update(id: string, patch: Partial<Pick<IStoredAccessToken, 'lastUsedAt' | 'revokedAt'>>): void {
    if (patch.lastUsedAt) this.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(patch.lastUsedAt.toISOString(), id)
    if (patch.revokedAt) this.db.prepare('UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(patch.revokedAt.toISOString(), id)
  }
}

const date = (value: unknown) => (typeof value === 'string' ? new Date(value) : undefined)

function toToken(row: TRow): IStoredAccessToken {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    prefix: String(row.prefix),
    createdAt: new Date(String(row.created_at)),
    expiresAt: date(row.expires_at),
    lastUsedAt: date(row.last_used_at),
    revokedAt: date(row.revoked_at),
  }
}
