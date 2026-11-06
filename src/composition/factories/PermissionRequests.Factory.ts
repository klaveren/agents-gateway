import { makeGuidance } from './Guidance.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'
import { PermissionRequestsService } from '@application/PermissionRequests.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqlitePermissionRequestRepository } from '@infra/persistence/Sqlite.PermissionRequestRepository'
import { makeAgents } from './Agents.Factory'
import { makeCatalogEvents } from './CatalogEvents.Factory'
import { makePermissions } from './Permissions.Factory'
import { makeProjects } from './Projects.Factory'

let service: PermissionRequestsService | undefined

/** Os pedidos de permissão dos agentes: UM serviço, no mesmo arquivo das conversas (`off`: em memória). */
export function makePermissionRequests(): PermissionRequestsService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  service = new PermissionRequestsService({
    repository: new SqlitePermissionRequestRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    agents: makeAgents(),
    projects: {
      exists: (projectId) => makeProjects().exists(projectId),
      name: (projectId) => (makeProjects().exists(projectId) ? makeProjects().get(projectId).name : undefined),
      rules: (projectId) => makePermissions().projectRules(projectId).rules,
      save: (projectId, rules, by, change) => makePermissions().saveProjectRules(projectId, rules, by, change),
    },
    events: makeCatalogEvents(),
    secrets: {
      save: (scope, scopeId, input, by, project) => makeResourceSecrets().save(scope, scopeId, input, by, project),
      exists: (scope, scopeId) => (scope === 'agent' ? !!makeAgents().get(scopeId) : makeGuidance().resourceKindOf(scopeId) === scope),
    },
  })
  return service
}
