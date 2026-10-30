import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IMcpContainer, IMcpProcess, IMcpServerConfig, MCP_SCOPE_SEPARATOR, mcpServerKey, TMcpAuth, TMcpKind, TMcpTransport } from '@domain/models/McpServer.Model'
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

/** Colunas que um arquivo antigo ainda não tem. */
const ADDED_COLUMNS: Array<{ column: string; definition: string }> = [
  { column: 'kind', definition: "TEXT NOT NULL DEFAULT 'remote'" },
  { column: 'container', definition: 'TEXT' },
  { column: 'process', definition: 'TEXT' },
  { column: 'identity', definition: 'INTEGER NOT NULL DEFAULT 0' },
  // Ausente (NULL) = global: o banco antigo continua todo global, sem migração.
  { column: 'project_id', definition: 'TEXT' },
]

const COLUMNS: Record<keyof TMcpServerPatch, string> = {
  name: 'name',
  url: 'url',
  container: 'container',
  process: 'process',
  transport: 'transport',
  auth: 'auth',
  headerName: 'header_name',
  identity: 'identity',
  enabled: 'enabled',
  updatedAt: 'updated_at',
  updatedBy: 'updated_by',
}

/**
 * Os servidores MCP, no mesmo arquivo das conversas. Sem arquivo, em memória (`:memory:`).
 *
 * ⚖️ A COLUNA `id` GUARDA A CHAVE (`mcpServerKey`), e `project_id` o escopo: a chave primária continua uma coluna só
 * (o SQLite não troca chave primária com `ALTER`), o banco antigo vale como está (tudo global, chave = id), e o mesmo
 * id em dois projetos são duas linhas (`a.n8n`, `b.n8n`).
 */
export class SqliteMcpServerRepository implements IMcpServerRepository {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const existing = this.db.prepare('PRAGMA table_info(mcp_servers)').all() as TRow[]
    for (const { column, definition } of ADDED_COLUMNS) {
      if (!existing.some((row) => row.name === column)) this.db.exec(`ALTER TABLE mcp_servers ADD COLUMN ${column} ${definition}`)
    }
  }

  list(): IMcpServerConfig[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC, id ASC').all() as TRow[]).map(toServer)
  }

  get(key: string): IMcpServerConfig | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(key) as TRow | undefined
    return row ? toServer(row) : undefined
  }

  insert(server: IMcpServerConfig): void {
    this.db
      .prepare(
        'INSERT INTO mcp_servers (id, project_id, name, kind, container, process, url, transport, auth, header_name, identity, enabled, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        mcpServerKey(server),
        server.projectId ?? null,
        server.name,
        server.kind ?? 'remote',
        server.container ? JSON.stringify(server.container) : null,
        server.process ? JSON.stringify(server.process) : null,
        server.url,
        server.transport,
        server.auth,
        server.headerName ?? null,
        server.identity ? 1 : 0,
        server.enabled ? 1 : 0,
        server.createdAt.toISOString(),
        server.updatedAt.toISOString(),
        server.updatedBy ?? null,
      )
  }

  update(key: string, patch: TMcpServerPatch): IMcpServerConfig | undefined {
    const keys = (Object.keys(patch) as Array<keyof TMcpServerPatch>).filter((key) => key in COLUMNS && (patch[key] !== undefined || key === 'headerName'))
    if (keys.length) {
      const values = keys.map((key) => {
        const value = patch[key]
        if (value === undefined || value === null) return null
        if (value instanceof Date) return value.toISOString()
        if (typeof value === 'boolean') return value ? 1 : 0
        if (typeof value === 'object') return JSON.stringify(value)
        return value as string
      })
      this.db.prepare(`UPDATE mcp_servers SET ${keys.map((column) => `${COLUMNS[column]} = ?`).join(', ')} WHERE id = ?`).run(...values, key)
    }
    return this.get(key)
  }

  move(key: string, projectId: string | undefined, at: Date, by: string): IMcpServerConfig | undefined {
    const current = this.get(key)
    if (!current) return undefined
    const next = mcpServerKey({ id: current.id, projectId })
    this.db.prepare('UPDATE mcp_servers SET id = ?, project_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(next, projectId ?? null, at.toISOString(), by, key)
    return this.get(next)
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(key).changes > 0
  }

  /**
   * ⚖️ A MARCA É POR SERVIDOR (`seeded:<id>`): uma semente nova (o MCP do próprio gateway) chega a um banco
   * antigo, e a que foi apagada não volta. A marca antiga, do banco inteiro, vale como a do `default`.
   */
  seedOnce(servers: readonly IMcpServerConfig[]): void {
    const legacy = !!this.db.prepare("SELECT 1 FROM mcp_meta WHERE key = 'seeded'").get()
    for (const server of servers) {
      const key = `seeded:${server.id}`
      if (this.db.prepare('SELECT 1 FROM mcp_meta WHERE key = ?').get(key) || (legacy && server.id === 'default')) continue
      // ⛔ Nem se um projeto já usa o id: global e de projeto com o mesmo id deixariam `mcp:<id>/…` ambíguo.
      if (!this.list().some((existing) => existing.id === server.id)) this.insert(server)
      this.db.prepare('INSERT INTO mcp_meta (key, value) VALUES (?, ?)').run(key, new Date().toISOString())
    }
  }
}

function toServer(row: TRow): IMcpServerConfig {
  const projectId = typeof row.project_id === 'string' && row.project_id ? row.project_id : undefined
  const key = String(row.id)
  return {
    id: projectId && key.startsWith(`${projectId}${MCP_SCOPE_SEPARATOR}`) ? key.slice(projectId.length + 1) : key,
    ...(projectId ? { projectId } : {}),
    name: String(row.name),
    kind: (typeof row.kind === 'string' ? row.kind : 'remote') as TMcpKind,
    ...(typeof row.container === 'string' ? { container: JSON.parse(row.container) as IMcpContainer } : {}),
    ...(typeof row.process === 'string' ? { process: JSON.parse(row.process) as IMcpProcess } : {}),
    url: String(row.url),
    transport: String(row.transport) as TMcpTransport,
    auth: String(row.auth) as TMcpAuth,
    headerName: typeof row.header_name === 'string' ? row.header_name : undefined,
    ...(Number(row.identity) === 1 ? { identity: true } : {}),
    enabled: Number(row.enabled) === 1,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
  }
}
