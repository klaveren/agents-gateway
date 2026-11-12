import { makeAgentProjectLayers } from './AgentProjectLayers.Factory'
import { makePermissions } from './Permissions.Factory'
import { migrateLegacyToProjects, migrateProjectRoles, ProjectsService } from '@application/Projects.Service'
import { AGENT_SEED, ATLAS_AGENTS } from '@domain/Agent.Seed'
import { gatewayEdition } from '@domain/Edition.Policy'
import { DEFAULT_PROJECT_ID } from '@domain/models/Project.Model'
import { IUser } from '@domain/models/User.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { projectWorkspace, removeProjectWorkspace } from '@infra/adapters/support/Subscription.Workspace'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { useProjectAccess } from '@infra/http/Project.Access'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeGuidance } from './Guidance.Factory'
import { removeProjectImports } from './ImportJobs.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { removeProjectMcpServers } from './McpServers.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'

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
        // ⛔ O projeto apagado sai da lista de compartilhamento dos agentes (os valores secretos dele saem em `removeProject` abaixo).
        makeAgents().removeProject(id, 'sistema')
        makeResourceSecrets().removeProject(id)
        makeAgentProjectLayers().removeProject(id)
        makePermissions().removeProject(id)
        makeProjectAccounts().removeProject(id)
        removeProjectMcpServers(id)
        removeProjectImports(id)
      },
    },
  )
  service.history.use(() => makeCatalogHistory())
  // Quem administra cada projeto: a regra das rotas (ver `Project.Access`).
  useProjectAccess({
    roles: service,
    agentProject: (agentId) => {
      const agent = makeAgents().get(agentId)
      return agent ? (agent.projectId ?? null) : undefined
    },
    // 🔌 Pedido na hora: as conexões nascem depois desta fábrica (e as duas se usam).
    connection: (projectId) => connectedProject(projectId),
  })
  // ⚖️ O gateway nasce com um projeto: o primeiro admin já administra o `geral` (sem projeto, a tela não deixava criar agente).
  makeAuth().accounts?.afterSetup((user) => {
    if (!service.exists(DEFAULT_PROJECT_ID)) service.create({ id: DEFAULT_PROJECT_ID, name: 'Geral', description: 'O projeto inicial do gateway.' }, user.name, 'boot', user.id)
  })
  // ⚖️ Na lite, todo usuário é membro do `geral` (o projeto dela): o criado agora e, no boot, o que já existia sem ser.
  if (gatewayEdition() === 'lite') {
    makeAuth().accounts?.afterCreate((user, by) => joinDefaultProject(service, [user], by))
    joinDefaultProject(service, makeAuth().accounts?.list() ?? [], 'boot')
  }
  instance = { service, repository }
  return instance
}

/** Põe no `geral` quem ainda não é membro: o admin do gateway como admin do projeto, os outros como membros. */
function joinDefaultProject(service: ProjectsService, users: readonly IUser[], by: string): void {
  if (!service.exists(DEFAULT_PROJECT_ID)) return
  const members = service.members(DEFAULT_PROJECT_ID)
  const missing = users.filter((user) => !members.some((member) => member.userId === user.id))
  if (!missing.length) return
  try {
    service.setMembers(
      DEFAULT_PROJECT_ID,
      [...members, ...missing.map((user) => ({ userId: user.id, role: user.role === 'admin' ? ('admin' as const) : ('member' as const) }))],
      by,
    )
  } catch (error) {
    console.warn('[lite] não foi possível pôr as contas no projeto geral', error)
  }
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
    adminIds: gatewayAdminIds,
    seedIds: [...new Set([...AGENT_SEED, ...ATLAS_AGENTS].map((agent) => agent.id))],
  })
  migrateProjectRoles({ repository, adminIds: gatewayAdminIds })
}

/** As contas ativas que administram o gateway. */
function gatewayAdminIds(): string[] {
  return (makeAuth().accounts?.list() ?? []).filter((user) => user.role === 'admin' && !user.disabled).map((user) => user.id)
}

/** O projeto conectado (ver `ProjectConnection.Service`); a fábrica dele é registrada na composição, sem volta entre as duas. */
let connectedProject: (projectId: string) => { url: string; localEnv?: Record<string, string> } | undefined = () => undefined

export function useConnectedProjects(lookup: (projectId: string) => { url: string; localEnv?: Record<string, string> } | undefined): void {
  connectedProject = lookup
}

/** As fixas desta máquina de um projeto conectado (ver `IProjectConnection.localEnv`); outro projeto, nenhuma. */
export const connectedLocalEnv = (projectId: string): Readonly<Record<string, string>> | undefined => connectedProject(projectId)?.localEnv

/** O projeto é conectado? (Para quem decide fora das rotas, como a camada local dos agentes.) */
export const isConnectedProject = (projectId: string): boolean => !!connectedProject(projectId)
