import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IRemoteUsageRow } from '@domain/models/RemoteUsage.Model'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS remote_usage (
    key                 TEXT NOT NULL,
    project_id          TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    email               TEXT NOT NULL,
    day                 TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    turns               INTEGER NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id, key)
  );
  CREATE INDEX IF NOT EXISTS remote_usage_day ON remote_usage (day);
`

type TRow = Record<string, unknown>
const n = (value: unknown) => Number(value) || 0

/** 🔌 O uso que os gateways conectados mandaram (ver `RemoteUsage.Model`), no mesmo arquivo das conversas. */
export class SqliteRemoteUsageRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  /** Grava ou SUBSTITUI cada linha (a chave é da conta e do projeto: a de uma conta nunca apaga a de outra). */
  upsert(rows: readonly IRemoteUsageRow[], at: Date): void {
    const statement = this.db.prepare(
      `INSERT INTO remote_usage (key, project_id, user_id, email, day, conversation_id, agent_id, provider, model, turns,
         input_tokens, output_tokens, reasoning_tokens, total_tokens, cache_read_tokens, cache_write_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id, key) DO UPDATE SET email = excluded.email, turns = excluded.turns,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens,
         total_tokens = excluded.total_tokens, cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
         updated_at = excluded.updated_at`,
    )
    for (const row of rows)
      statement.run(
        row.key,
        row.projectId,
        row.userId,
        row.email,
        row.day,
        row.conversationId,
        row.agentId,
        row.provider,
        row.model,
        row.turns,
        n(row.usage.inputTokens),
        n(row.usage.outputTokens),
        n(row.usage.reasoningTokens),
        n(row.usage.totalTokens),
        n(row.usage.cacheReadTokens),
        n(row.usage.cacheWriteTokens),
        at.toISOString(),
      )
  }

  /** As linhas de um dia em diante (`YYYY-MM-DD`). */
  since(day: string): IRemoteUsageRow[] {
    return (this.db.prepare('SELECT * FROM remote_usage WHERE day >= ? ORDER BY day').all(day) as TRow[]).map((row) => ({
      key: String(row.key),
      projectId: String(row.project_id),
      userId: String(row.user_id),
      email: String(row.email),
      day: String(row.day),
      conversationId: String(row.conversation_id),
      agentId: String(row.agent_id),
      provider: String(row.provider),
      model: String(row.model),
      turns: n(row.turns),
      usage: {
        inputTokens: n(row.input_tokens),
        outputTokens: n(row.output_tokens),
        reasoningTokens: n(row.reasoning_tokens),
        totalTokens: n(row.total_tokens),
        cacheReadTokens: n(row.cache_read_tokens),
        cacheWriteTokens: n(row.cache_write_tokens),
      },
    }))
  }
}
