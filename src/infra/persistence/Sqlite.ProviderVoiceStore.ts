import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IProviderVoice, IProviderVoices, IProviderVoiceStore } from '@domain/models/ProviderVoice.Model'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS provider_voices (
    provider_id  TEXT PRIMARY KEY,
    voices       TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
  );
`

/** 🎙️ As vozes da conta de cada provider, no mesmo arquivo das conversas. Sem arquivo, em memória. */
export class SqliteProviderVoiceStore implements IProviderVoiceStore {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  get(providerId: string): IProviderVoices {
    const row = this.db.prepare('SELECT voices, fetched_at FROM provider_voices WHERE provider_id = ?').get(providerId) as { voices?: unknown; fetched_at?: unknown } | undefined
    if (!row || typeof row.voices !== 'string') return { voices: [] }
    try {
      const parsed = JSON.parse(row.voices) as IProviderVoice[]
      return { voices: Array.isArray(parsed) ? parsed : [], ...(typeof row.fetched_at === 'string' ? { fetchedAt: row.fetched_at } : {}) }
    } catch {
      return { voices: [] }
    }
  }

  set(providerId: string, voices: IProviderVoice[], at: Date): void {
    this.db
      .prepare(
        'INSERT INTO provider_voices (provider_id, voices, fetched_at) VALUES (?, ?, ?) ON CONFLICT (provider_id) DO UPDATE SET voices = excluded.voices, fetched_at = excluded.fetched_at',
      )
      .run(providerId, JSON.stringify(voices), at.toISOString())
  }

  clear(providerId: string): void {
    this.db.prepare('DELETE FROM provider_voices WHERE provider_id = ?').run(providerId)
  }
}
