import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IMcpServerConfig, TMcpAuth, TMcpTransport } from '@domain/models/McpServer.Model'
import { IMcpServerRepository, TMcpServerPatch } from '@domain/ports/McpServerRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id           TEXT    NOT NULL PRIMARY KEY,
    name         TEXT    NOT NULL,
    url          TEXT    NOT NULL,
    transport    TEXT    NOT NULL DEFAULT 'auto',
    auth         TEXT    NOT NULL DEFAULT 'caller',
    header_name  TEXT,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    updated_by   TEXT
  );
  CREATE TABLE IF NOT EXISTS mcp_meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  );
`

type TRow = Record<string, unknown>

const COLUMNS: Record<keyof TMcpServerPatch, string> = {
  name: 'name',
  url: 'url',
  transport: 'transport',
  auth: 'auth',
  headerName: 'header_name',
  enabled: 'enabled',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}

/** Os servidores MCP, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`). */
export class SqliteMcpServerRepository implements IMcpServerRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(): IMcpServerConfig[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC, id ASC').all() as TRow[]).map(toServer)
  }

  get(id: string): IMcpServerConfig | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as TRow | undefined
    return row ? toServer(row) : undefined
  }

  insert(server: IMcpServerConfig): void {
    this.db
      .prepare('INSERT INTO mcp_servers (id, name, url, transport, auth, header_name, enabled, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        server.id,
        server.name,
        server.url,
        server.transport,
        server.auth,
        server.headerName ?? null,
        server.enabled ? 1 : 0,
        server.createdAt.toISOString(),
        server.updatedAt.toISOString(),
        server.updatedBy ?? null,
      )
  }

  update(id: string, patch: TMcpServerPatch): IMcpServerConfig | undefined {
    const keys = (Object.keys(patch) as Array<keyof TMcpServerPatch>).filter((key) => key in COLUMNS && (patch[key] !== undefined || key === 'headerName'))
    if (keys.length) {
      const values = keys.map((key) => {
        const value = patch[key]
        if (value === undefined || value === null) return null
        if (value instanceof Date) return value.toISOString()
        if (typeof value === 'boolean') return value ? 1 : 0
        return value as string
      })
      this.db.prepare(`UPDATE mcp_servers SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
    }
    return this.get(id)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0
  }

  seedOnce(servers: readonly IMcpServerConfig[]): void {
    if (this.db.prepare("SELECT 1 FROM mcp_meta WHERE key = 'seeded'").get()) return
    for (const server of servers) if (!this.get(server.id)) this.insert(server)
    this.db.prepare("INSERT INTO mcp_meta (key, value) VALUES ('seeded', ?)").run(new Date().toISOString())
  }
}

function toServer(row: TRow): IMcpServerConfig {
  return {
    id: String(row.id),
    name: String(row.name),
    url: String(row.url),
    transport: String(row.transport) as TMcpTransport,
    auth: String(row.auth) as TMcpAuth,
    headerName: typeof row.header_name === 'string' ? row.header_name : undefined,
    enabled: Number(row.enabled) === 1,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
  }
}
