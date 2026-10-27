import { GuidanceService } from '@application/Guidance.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { makeProjects } from './Projects.Factory'

let instance: GuidanceService | undefined

/** As rules e os documentos: UM serviço, no mesmo arquivo das conversas (a tela, o MCP e as conversas o dividem). */
export function makeGuidance(): GuidanceService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new GuidanceService(new SqliteGuidanceRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH), (projectId) => makeProjects().exists(projectId))
  return instance
}
