import { makePermissions } from './Permissions.Factory'
import { migrateLegacyToProjects, ProjectsService } from '@application/Projects.Service'
import { AGENT_SEED } from '@domain/Agent.Seed'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { projectWorkspace, removeProjectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeGuidance } from './Guidance.Factory'
import { removeProjectImports } from './ImportJobs.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { removeProjectMcpServers } from './McpServers.Factory'

let instance: { service: ProjectsService; repository: SqliteProjectRepository } | undefined

/** Os projetos: UM serviço, no mesmo arquivo das conversas (o controller dos agentes e o dos projetos o dividem). */
export function makeProjects(): ProjectsService {
  return build().service
}

function build() {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const repository = new SqliteProjectRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  const service = new ProjectsService(
    repository,
    () =>
      makeAgents()
        .rawEntries()
        .map((entry) => entry.agent),
    (userId) =>
      !makeAuth().accounts ||
      makeAuth()
        .accounts!.list()
        .some((user) => user.id === userId),
    {
      create: (id) => projectWorkspace(id),
      // As rules, os documentos, as permissões, as contas, os MCPs e os trabalhos de importação do projeto vão junto com a pasta.
      remove: (id) => {
        removeProjectWorkspace(id)
        makeGuidance().removeProject(id)
        makePermissions().removeProject(id)
        makeProjectAccounts().removeProject(id)
        removeProjectMcpServers(id)
        removeProjectImports(id)
      },
    },
  )
  service.history.use(() => makeCatalogHistory())
  instance = { service, repository }
  return instance
}

/** O repositório dos projetos, para o leitor do catálogo (o histórico). */
export function projectRepository(): SqliteProjectRepository {
  return build().repository
}

/** Uma vez: o que existia antes dos projetos vai para o projeto `geral` (ver `migrateLegacyToProjects`). */
export async function migrateToProjects(conversations: IConversationRepository): Promise<void> {
  const { service, repository } = build()
  await migrateLegacyToProjects({
    service,
    repository,
    agents: makeAgents(),
    conversations,
    userIds: () => (makeAuth().accounts?.list() ?? []).map((user) => user.id),
    seedIds: AGENT_SEED.map((agent) => agent.id),
  })
}
