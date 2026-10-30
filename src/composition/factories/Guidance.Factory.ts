import { GuidanceService } from '@application/Guidance.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { makeAgents } from './Agents.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeProjects } from './Projects.Factory'

let instance: GuidanceService | undefined
let repository: SqliteGuidanceRepository | undefined

/** As rules e os documentos: UM serviço, no mesmo arquivo das conversas (a tela, o MCP e as conversas o dividem). */
export function makeGuidance(): GuidanceService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  repository = new SqliteGuidanceRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  instance = new GuidanceService(
    repository,
    (projectId) => makeProjects().exists(projectId),
    (agentId) => {
      const agent = makeAgents().get(agentId)
      return agent ? { id: agent.id, ...(agent.projectId ? { projectId: agent.projectId } : {}), ...(agent.triggers?.length ? { triggers: agent.triggers } : {}) } : undefined
    },
  )
  instance.history.use(() => makeCatalogHistory())
  return instance
}

/** O repositório das rules, docs e recursos, para o leitor do catálogo (o histórico). */
export function guidanceRepository(): SqliteGuidanceRepository {
  makeGuidance()
  return repository!
}
