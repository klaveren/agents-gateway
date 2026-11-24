import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IImageUsageEntry } from '@domain/models/ImageUsage.Model'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS image_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    project_id    TEXT,
    agent_id      TEXT,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS image_usage_at ON image_usage (at);
`

type TRow = Record<string, unknown>
const n = (value: unknown) => Number(value) || 0

/** 🖼️ O uso das imagens (ver `ImageUsage.Model`), no mesmo arquivo das conversas. */
export class SqliteImageUsageRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  record(entry: IImageUsageEntry): void {
    this.db
      .prepare('INSERT INTO image_usage (at, user_id, project_id, agent_id, provider, model, input_tokens, output_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        entry.at.toISOString(),
        entry.userId,
        entry.projectId ?? null,
        entry.agentId ?? null,
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.totalTokens,
      )
  }

  /** As imagens de um instante em diante. */
  since(at: Date): IImageUsageEntry[] {
    return (this.db.prepare('SELECT * FROM image_usage WHERE at >= ? ORDER BY at').all(at.toISOString()) as TRow[]).map((row) => ({
      at: new Date(String(row.at)),
      userId: String(row.user_id),
      ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
      ...(typeof row.agent_id === 'string' ? { agentId: row.agent_id } : {}),
      provider: String(row.provider),
      model: String(row.model),
      inputTokens: n(row.input_tokens),
      outputTokens: n(row.output_tokens),
      totalTokens: n(row.total_tokens),
    }))
  }
}
