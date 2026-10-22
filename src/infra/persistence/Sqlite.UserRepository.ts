import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IStoredUser, TUserRole } from '@domain/models/User.Model'
import { IUserRepository, TUserPatch } from '@domain/ports/UserRepository.Port'

/**
 * ⚖️ `email` ÚNICO no banco, e não só na regra: dois cadastros simultâneos com o mesmo e-mail passariam
 * pela conferência da regra juntos; o índice é o que garante. `auth_secret` tem uma linha só (o
 * `CHECK`): é a chave que assina os tokens quando `AUTH_SECRET` não vem do ambiente.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT    NOT NULL PRIMARY KEY,
    email          TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL,
    role           TEXT    NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    password_hash  TEXT    NOT NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL,
    updated_by     TEXT,
    last_login_at  TEXT,
    session_version INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS auth_secret (
    id      INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
    secret  TEXT    NOT NULL
  );
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TUserPatch, string> = {
  name: 'name',
  role: 'role',
  disabled: 'disabled',
  passwordHash: 'password_hash',
  lastLoginAt: 'last_login_at',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
  sessionVersion: 'session_version',
}

export class SqliteUserRepository implements IUserRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as TRow).n)
  }

  list(): IStoredUser[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all() as TRow[]).map(toUser)
  }

  findById(id: string): IStoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as TRow | undefined
    return row ? toUser(row) : undefined
  }

  findByEmail(email: string): IStoredUser | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as TRow | undefined
    return row ? toUser(row) : undefined
  }

  insert(user: IStoredUser): void {
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, role, disabled, password_hash, created_at, updated_at, updated_by, last_login_at, session_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.email,
        user.name,
        user.role,
        user.disabled ? 1 : 0,
        user.passwordHash,
        user.createdAt.toISOString(),
        user.updatedAt.toISOString(),
        user.updatedBy ?? null,
        user.lastLoginAt?.toISOString() ?? null,
        user.sessionVersion,
      )
  }

  update(id: string, patch: TUserPatch): IStoredUser | undefined {
    // As colunas vêm de um mapa FIXO, nunca da entrada: só os valores viram parâmetro.
    const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && key in COLUMNS) as Array<[keyof TUserPatch, unknown]>
    if (entries.length) {
      const sql = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ')
      const values = entries.map(([, value]) => (value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? (value ? 1 : 0) : (value as string | number)))
      this.db.prepare(`UPDATE users SET ${sql} WHERE id = ?`).run(...values, id)
    }
    return this.findById(id)
  }

  /** A chave que assina os tokens: lida do banco, ou gerada uma vez e guardada. */
  signingSecret(): string {
    const row = this.db.prepare('SELECT secret FROM auth_secret WHERE id = 1').get() as TRow | undefined
    if (row) return String(row.secret)

    const secret = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT OR IGNORE INTO auth_secret (id, secret) VALUES (1, ?)').run(secret)
    return String((this.db.prepare('SELECT secret FROM auth_secret WHERE id = 1').get() as TRow).secret)
  }

  close(): void {
    this.db.close()
  }
}

function toUser(row: TRow): IStoredUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role) as TUserRole,
    disabled: Number(row.disabled) === 1,
    passwordHash: String(row.password_hash),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
    lastLoginAt: typeof row.last_login_at === 'string' ? new Date(row.last_login_at) : undefined,
    sessionVersion: Number(row.session_version ?? 0),
  }
}
