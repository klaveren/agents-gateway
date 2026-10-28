import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentRepository, IStoredAgent } from '@domain/ports/AgentRepository.Port'

/**
 * O agente inteiro num documento JSON, e o id ao lado para ser a chave.
 *
 * ⚖️ DOCUMENTO, e não uma coluna por campo: o `IAgent` ganha campo com o tempo (esforços de
 * raciocínio já chegaram assim), e cada campo novo viraria uma migração. Ninguém consulta agente por
 * modelo ou por tool no banco — a lista é pequena e é lida inteira.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agents (
    id          TEXT NOT NULL PRIMARY KEY,
    document    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_meta (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL
  );
`

type TRow = Record<string, unknown>

/** Os agentes criados pela tela, no mesmo arquivo das conversas (`CONVERSATIONS_DB`). */
export class SqliteAgentRepository implements IAgentRepository {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })

    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  list(): IStoredAgent[] {
    try {
      const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at ASC, id ASC').all() as TRow[]

      return rows.flatMap((row) => {
        const agent = this.toAgent(row)
        return agent ? [agent] : []
      })
    } catch (error) {
      // ⛔ Ler não derruba: a lista vem vazia e o resto do gateway segue.
      console.warn('[sqlite] não foi possível ler os agentes; seguindo sem nenhum.', error)
      return []
    }
  }

  /** ⛔ Lança: é ação de quem administra, e falhar em silêncio diria "salvo". */
  save(agent: IAgent, by: string): IStoredAgent {
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO agents (id, document, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(agent.id, JSON.stringify(agent), now, now, by)

    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agent.id) as TRow
    return this.toAgent(row) as IStoredAgent
  }

  /**
   * Grava a semente UMA VEZ por banco. ⚖️ A marca (`agent_meta`, `seeded:<id>`) é o que impede um agente apagado
   * de voltar no boot seguinte; id que já existe não é sobrescrito.
   */
  seedOnce(agents: readonly IAgent[], by: string): void {
    // ⚖️ A marca é POR AGENTE (`seeded:<id>`): um agente novo na semente chega a um banco antigo, e um
    // apagado não volta.
    const now = new Date().toISOString()
    const insert = this.db.prepare('INSERT OR IGNORE INTO agents (id, document, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)')
    const marked = this.db.prepare('SELECT 1 FROM agent_meta WHERE key = ?')
    const mark = this.db.prepare('INSERT OR IGNORE INTO agent_meta (key, value) VALUES (?, ?)')

    for (const agent of agents) {
      const key = `seeded:${agent.id}`
      if (marked.get(key)) {
        this.grantSeedTools(agent, now, by)
        continue
      }
      insert.run(agent.id, JSON.stringify(agent), now, now, by)
      mark.run(key, now)
      for (const tool of agent.allowedTools) mark.run(`seed-tool:${agent.id}:${tool}`, now)
    }
  }

  /**
   * ⚖️ A FERRAMENTA NOVA DA SEMENTE chega ao agente que já existe (o Atlas de um banco antigo ganha as de rules e
   * documentos), UMA VEZ cada (`seed-tool:<agente>:<ferramenta>`): tirada depois pela tela, não volta. O resto do
   * agente (prompt, modelos) é de quem administra e não se toca.
   */
  private grantSeedTools(agent: IAgent, now: string, by: string): void {
    const marked = this.db.prepare('SELECT 1 FROM agent_meta WHERE key = ?')
    const mark = this.db.prepare('INSERT OR IGNORE INTO agent_meta (key, value) VALUES (?, ?)')
    const fresh = agent.allowedTools.filter((tool) => !marked.get(`seed-tool:${agent.id}:${tool}`))
    if (!fresh.length) return
    const row = this.db.prepare('SELECT document FROM agents WHERE id = ?').get(agent.id) as { document: string } | undefined
    if (row) {
      const document = JSON.parse(row.document) as { allowedTools?: string[] }
      const current = document.allowedTools ?? []
      const added = fresh.filter((tool) => !current.includes(tool))
      if (added.length) {
        document.allowedTools = [...current, ...added]
        this.db.prepare('UPDATE agents SET document = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(JSON.stringify(document), now, by, agent.id)
        console.log(`[agentes] ${agent.id} ganhou ${added.length} ferramenta(s) da semente: ${added.join(', ')}`)
      }
    }
    for (const tool of fresh) mark.run(`seed-tool:${agent.id}:${tool}`, now)
  }

  migrateOnce(key: string, agentId: string, change: (agent: IAgent) => IAgent | undefined, by: string): void {
    const mark = `migration:${key}:${agentId}`
    if (this.db.prepare('SELECT 1 FROM agent_meta WHERE key = ?').get(mark)) return
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as TRow | undefined
    const current = row ? this.toAgent(row) : undefined
    if (current) {
      const { createdAt: _created, updatedAt: _updated, updatedBy: _by, ...agent } = current
      const next = change(agent)
      if (next) {
        this.save(next, by)
        console.log(`[agentes] ${agentId}: migração ${key} aplicada`)
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO agent_meta (key, value) VALUES (?, ?)').run(mark, new Date().toISOString())
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0
  }

  close(): void {
    this.db.close()
  }

  /**
   * ⚠️ Documento que não se lê é PULADO, com aviso — não derruba a lista inteira. Um agente perdido
   * é ruim; a tela de agentes vazia por causa de um registro corrompido é pior.
   */
  private toAgent(row: TRow): IStoredAgent | undefined {
    try {
      const document = withProviders(JSON.parse(String(row.document)) as TStoredDocument)

      return {
        ...document,
        id: String(row.id),
        createdAt: new Date(String(row.created_at)),
        updatedAt: new Date(String(row.updated_at)),
        updatedBy: typeof row.updated_by === 'string' ? row.updated_by : undefined,
      }
    } catch {
      console.warn(`[sqlite] agente ilegível ignorado: ${String(row.id)}`)
      return undefined
    }
  }
}

/** O documento como pode estar gravado: no formato atual ou no de antes de `providers`. */
type TStoredDocument = IAgent & { provider?: string; models?: string[] }

/**
 * ⚖️ O formato de antes (`provider` + `models`, um provider só) vira um `providers` de um item NA
 * LEITURA: os bancos que já existem (o do pod inclusive) seguem sem migração, e o próximo salvamento
 * grava no formato novo.
 */
export function withProviders(document: TStoredDocument): IAgent {
  const { provider, models, ...agent } = document
  if (Array.isArray(agent.providers)) return agent
  return { ...agent, providers: provider ? [{ provider, models: models ?? [] }] : [] }
}
