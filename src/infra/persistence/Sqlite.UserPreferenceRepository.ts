import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IUserPreferenceRepository } from '@domain/ports/UserPreferenceRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id     TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`

/** ⚙️ As preferências das pessoas, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteUserPreferenceRepository implements IUserPreferenceRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  get(userId: string, key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?').get(userId, key) as { value?: unknown } | undefined
    return typeof row?.value === 'string' ? row.value : undefined
  }

  set(userId: string, key: string, value: string, at: Date): void {
    this.db
      .prepare(
        'INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      )
      .run(userId, key, value, at.toISOString())
  }

  remove(userId: string, key: string): void {
    this.db.prepare('DELETE FROM user_preferences WHERE user_id = ? AND key = ?').run(userId, key)
  }
}
