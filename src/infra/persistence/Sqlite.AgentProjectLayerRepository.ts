import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IAgentProjectLayer } from '@domain/models/AgentLocalLayer.Model'
import { IAgentProjectLayerRepository } from '@domain/ports/AgentProjectLayerRepository.Port'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_project_layers (
    agent_id        TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    providers       TEXT,
    allowed_tools   TEXT NOT NULL DEFAULT '[]',
    disabled_tools  TEXT NOT NULL DEFAULT '[]',
    permissions     TEXT NOT NULL DEFAULT '[]',
    updated_at      TEXT NOT NULL,
    updated_by      TEXT NOT NULL,
    PRIMARY KEY (agent_id, project_id)
  );
`

type TRow = Record<string, unknown>

const keyOf = (agentId: string, projectId: string) => `${agentId}\u0000${projectId}`

/**
 * As camadas dos agentes globais em cada projeto, no mesmo arquivo das conversas.
 * ⚖️ Lidas a cada turno (o agente como roda no projeto da conversa): ficam em memória, e o banco só é escrito.
 */
export class SqliteAgentProjectLayerRepository implements IAgentProjectLayerRepository {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, IAgentProjectLayer>()

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    for (const row of this.db.prepare('SELECT * FROM agent_project_layers ORDER BY agent_id, project_id').all() as TRow[]) {
      const layer = toLayer(row)
      this.cache.set(keyOf(layer.agentId, layer.projectId), layer)
    }
  }

  get(agentId: string, projectId: string): IAgentProjectLayer | undefined {
    return this.cache.get(keyOf(agentId, projectId))
  }

  list(): IAgentProjectLayer[] {
    return [...this.cache.values()]
  }

  save(layer: IAgentProjectLayer): void {
    this.db
      .prepare(
        `INSERT INTO agent_project_layers (agent_id, project_id, providers, allowed_tools, disabled_tools, permissions, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, project_id) DO UPDATE SET providers = excluded.providers, allowed_tools = excluded.allowed_tools,
           disabled_tools = excluded.disabled_tools, permissions = excluded.permissions, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(
        layer.agentId,
        layer.projectId,
        layer.providers?.length ? JSON.stringify(layer.providers) : null,
        JSON.stringify(layer.allowedTools),
        JSON.stringify(layer.disabledTools ?? []),
        JSON.stringify(layer.permissions),
        layer.updatedAt.toISOString(),
        layer.updatedBy,
      )
    this.cache.set(keyOf(layer.agentId, layer.projectId), layer)
  }

  remove(agentId: string, projectId: string): void {
    this.db.prepare('DELETE FROM agent_project_layers WHERE agent_id = ? AND project_id = ?').run(agentId, projectId)
    this.cache.delete(keyOf(agentId, projectId))
  }

  removeAgent(agentId: string): void {
    this.db.prepare('DELETE FROM agent_project_layers WHERE agent_id = ?').run(agentId)
    for (const layer of this.list().filter((item) => item.agentId === agentId)) this.cache.delete(keyOf(layer.agentId, layer.projectId))
  }

  removeProject(projectId: string): void {
    this.db.prepare('DELETE FROM agent_project_layers WHERE project_id = ?').run(projectId)
    for (const layer of this.list().filter((item) => item.projectId === projectId)) this.cache.delete(keyOf(layer.agentId, layer.projectId))
  }
}

function toLayer(row: TRow): IAgentProjectLayer {
  const providers = row.providers ? (JSON.parse(String(row.providers)) as IAgentProjectLayer['providers']) : undefined
  const disabledTools = JSON.parse(String(row.disabled_tools ?? '[]')) as string[]
  return {
    agentId: String(row.agent_id),
    projectId: String(row.project_id),
    ...(providers?.length ? { providers } : {}),
    allowedTools: JSON.parse(String(row.allowed_tools)) as string[],
    ...(disabledTools.length ? { disabledTools } : {}),
    permissions: JSON.parse(String(row.permissions)) as IAgentProjectLayer['permissions'],
    updatedAt: new Date(String(row.updated_at)),
    updatedBy: String(row.updated_by),
  }
}
