import { GuidanceService } from '@application/Guidance.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { makeAgents } from './Agents.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeLedger } from './Ledger.Factory'
import { makeProjects } from './Projects.Factory'
import { makeResourceFiles } from './ResourceFiles.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'

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
  instance.useFiles(makeResourceFiles())
  // ⛔ Toda troca do `sharedWith` (rota, restaurar, import, mudar de dono) apaga os valores secretos de quem saiu.
  instance.useSharesChanged((id, projects) => makeResourceSecrets().keepProjects(id, projects))
  // O índice do ledger de cada agente no prompt (pedido na hora: o ledger lê os agentes).
  instance.useLedger((agentId) => makeLedger().promptSection(agentId))
  return instance
}

/** O repositório das rules, docs e recursos, para o leitor do catálogo (o histórico). */
export function guidanceRepository(): SqliteGuidanceRepository {
  makeGuidance()
  return repository!
}
