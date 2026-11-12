import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IAgentLocalLayer } from '@domain/models/AgentLocalLayer.Model'
import { IAgentLocalLayerRepository } from '@domain/ports/AgentLocalLayerRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_local_layers (
    agent_id       TEXT NOT NULL PRIMARY KEY,
    providers      TEXT,
    allowed_tools  TEXT NOT NULL DEFAULT '[]',
    permissions    TEXT NOT NULL DEFAULT '[]',
    updated_at     TEXT NOT NULL,
    updated_by     TEXT NOT NULL
  );
`

type TRow = Record<string, unknown>

/** Colunas que um arquivo antigo ainda não tem. */
const ADDED_COLUMNS: Array<{ column: string; definition: string }> = [
  // O que veio da origem e está desligado aqui (ver `IAgentLocalLayer.disabledTools`), em JSON.
  { column: 'disabled_tools', definition: "TEXT NOT NULL DEFAULT '[]'" },
]

/**
 * As camadas locais dos agentes de projeto conectado, no mesmo arquivo das conversas.
 * ⚖️ Lidas a cada vez que um agente é pedido (`AgentCatalog.effective`): ficam em memória, e o banco só é escrito.
 */
export class SqliteAgentLocalLayerRepository implements IAgentLocalLayerRepository {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, IAgentLocalLayer>()

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    const existing = this.db.prepare('PRAGMA table_info(agent_local_layers)').all() as TRow[]
    for (const { column, definition } of ADDED_COLUMNS) {
      if (!existing.some((row) => row.name === column)) this.db.exec(`ALTER TABLE agent_local_layers ADD COLUMN ${column} ${definition}`)
    }
    for (const row of this.db.prepare('SELECT * FROM agent_local_layers ORDER BY agent_id').all() as TRow[]) {
      const layer = toLayer(row)
      this.cache.set(layer.agentId, layer)
    }
  }

  get(agentId: string): IAgentLocalLayer | undefined {
    return this.cache.get(agentId)
  }

  list(): IAgentLocalLayer[] {
    return [...this.cache.values()]
  }

  save(layer: IAgentLocalLayer): void {
    this.db
      .prepare(
        `INSERT INTO agent_local_layers (agent_id, providers, allowed_tools, disabled_tools, permissions, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET providers = excluded.providers, allowed_tools = excluded.allowed_tools,
           disabled_tools = excluded.disabled_tools, permissions = excluded.permissions, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        layer.agentId,
        layer.providers?.length ? JSON.stringify(layer.providers) : null,
        JSON.stringify(layer.allowedTools),
        JSON.stringify(layer.disabledTools ?? []),
        JSON.stringify(layer.permissions),
        layer.updatedAt.toISOString(),
        layer.updatedBy,
      )
    this.cache.set(layer.agentId, layer)
  }

  remove(agentId: string): void {
    this.db.prepare('DELETE FROM agent_local_layers WHERE agent_id = ?').run(agentId)
    this.cache.delete(agentId)
  }
}

function toLayer(row: TRow): IAgentLocalLayer {
  const providers = row.providers ? (JSON.parse(String(row.providers)) as IAgentLocalLayer['providers']) : undefined
  const disabledTools = JSON.parse(String(row.disabled_tools ?? '[]')) as string[]
  return {
    agentId: String(row.agent_id),
    ...(providers?.length ? { providers } : {}),
    allowedTools: JSON.parse(String(row.allowed_tools)) as string[],
    ...(disabledTools.length ? { disabledTools } : {}),
    permissions: JSON.parse(String(row.permissions)) as IAgentLocalLayer['permissions'],
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: String(row.updated_by),
  }
}
