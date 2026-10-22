import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConfig, OFFICIAL_PROVIDERS } from '@domain/models/Provider.Model'
import { IProviderRepository, TProviderPatch } from '@domain/ports/ProviderRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS providers (
    id          TEXT    NOT NULL PRIMARY KEY,
    name        TEXT    NOT NULL,
    protocol    TEXT    NOT NULL,
    base_url    TEXT,
    official    INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    updated_by  TEXT
  );
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TProviderPatch, string> = { name: 'name', baseUrl: 'base_url', enabled: 'enabled', updatedAt: 'updated_at', updatedBy: 'updated_by' }

/**
 * Os providers, no mesmo arquivo das conversas. Sem arquivo (`path` ausente), em memória.
 *
 * ⚖️ OS TRÊS OFICIAIS NASCEM SEMPRE (`INSERT OR IGNORE` a cada boot): um banco novo, ou um anterior aos
 * providers virarem dado, sai com `claude`, `openai` e `google` — e os agentes e conversas que já
 * apontam para esses ids continuam válidos.
 */
export class SqliteProviderRepository implements IProviderRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)

    const now = new Date().toISOString()
    const seed = this.db.prepare('INSERT OR IGNORE INTO providers (id, name, protocol, base_url, official, enabled, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, 1, ?, ?)')
    for (const provider of OFFICIAL_PROVIDERS) seed.run(provider.id, provider.name, provider.protocol, now, now)
  }

  list(): IProviderConfig[] {
    // Oficiais primeiro, na ordem de sempre; os compatíveis depois, pela criação.
    return (this.db.prepare('SELECT * FROM providers ORDER BY official DESC, created_at ASC, id ASC').all() as TRow[]).map(toProvider).sort((a, b) => order(a) - order(b))
  }

  get(id: string): IProviderConfig | undefined {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as TRow | undefined
    return row ? toProvider(row) : undefined
  }

  insert(provider: IProviderConfig): void {
    this.db
      .prepare('INSERT INTO providers (id, name, protocol, base_url, official, enabled, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        provider.id,
        provider.name,
        provider.protocol,
        provider.baseUrl ?? null,
        provider.official ? 1 : 0,
        provider.enabled ? 1 : 0,
        provider.createdAt.toISOString(),
        provider.updatedAt.toISOString(),
        provider.updatedBy ?? null,
      )
  }

  update(id: string, patch: TProviderPatch): IProviderConfig | undefined {
    const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && key in COLUMNS) as Array<[keyof TProviderPatch, unknown]>
    if (entries.length) {
      const values = entries.map(([, value]) => (value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? (value ? 1 : 0) : (value as string)))
      this.db.prepare(`UPDATE providers SET ${entries.map(([key]) => `${COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
    }
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM providers WHERE id = ? AND official = 0').run(id).changes > 0
  }
}

function order(provider: IProviderConfig): number {
  const official = OFFICIAL_PROVIDERS.findIndex((item) => item.id === provider.id)
  return official === -1 ? OFFICIAL_PROVIDERS.length : official
}

function toProvider(row: TRow): IProviderConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    protocol: String(row.protocol) as EProvider,
    baseUrl: typeof row.base_url === 'string' && row.base_url ? row.base_url : undefined,
    official: Number(row.official) === 1,
    enabled: Number(row.enabled) === 1,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
  }
}
