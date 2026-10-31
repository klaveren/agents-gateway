import { randomBytes } from 'node:crypto'
import { AgentCatalog } from '@application/Agent.Catalog'
import { CatalogReader } from '@application/Catalog.Reader'
import { CatalogWriter, ICatalogWriter } from '@application/Catalog.Writer'
import { CatalogHistoryService } from '@application/CatalogHistory.Service'
import { CatalogImportApplier } from '@application/CatalogImport.Apply'
import { CatalogImportPlanner } from '@application/CatalogImport.Plan'
import { CatalogRestoreUseCase } from '@application/CatalogRestore.Usecase'
import { GuidanceService } from '@application/Guidance.Service'
import { McpServersService } from '@application/McpServers.Service'
import { PermissionsService } from '@application/Permissions.Service'
import { ProjectsService } from '@application/Projects.Service'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SqlitePermissionRepository } from '@infra/persistence/Sqlite.PermissionRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'

/** As regras do cadastro de agente nos testes: duas ferramentas avulsas e as do terminal e dos arquivos; todo modelo é do Google. */
export const TEST_AGENT_RULES = { knownTools: ['alpha_tool', 'beta_tool', 'run_bash', 'read_file', 'write_file'], providerOf: () => EProvider.GOOGLE }

/**
 * O CATÁLOGO DE VERDADE EM MEMÓRIA (só para testes): os repositórios SQLite, os serviços de escrita com o histórico
 * ligado, o leitor, o escritor, o plano, o apply e o rollback — o mesmo caminho da composição. `wrapWriter` deixa o teste
 * pôr uma falha no meio de um lote.
 */
export function buildCatalogStack(options: { wrapWriter?: (writer: ICatalogWriter) => ICatalogWriter; newId?: () => string } = {}) {
  const repos = {
    agents: new SqliteAgentRepository(':memory:'),
    guidance: new SqliteGuidanceRepository(':memory:'),
    permissions: new SqlitePermissionRepository(':memory:'),
    mcps: new SqliteMcpServerRepository(':memory:'),
    projects: new SqliteProjectRepository(':memory:'),
  }
  const repository = new SqliteCatalogHistoryRepository(':memory:')
  const reader = new CatalogReader(repos)
  const history = new CatalogHistoryService(repository, reader)
  const secrets = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:')
  const agents = new AgentCatalog(repos.agents)
  const agentExists = (agentId: string) => agents.rawEntries().some((entry) => entry.agent.id === agentId)
  const guidance = new GuidanceService(
    repos.guidance,
    (projectId) => !!repos.projects.get(projectId),
    (agentId) => {
      const found = agents.rawEntries().find((entry) => entry.agent.id === agentId)?.agent
      return found ? { id: found.id, ...(found.projectId ? { projectId: found.projectId } : {}) } : undefined
    },
  )
  const permissions = new PermissionsService(repos.permissions, () => undefined)
  const mcps = new McpServersService(
    repos.mcps,
    secrets,
    () => agents.rawEntries().map((entry) => entry.agent),
    (projectId) => !!repos.projects.get(projectId),
  )
  const projects = new ProjectsService(
    repos.projects,
    () => agents.rawEntries().map((entry) => entry.agent),
    () => true,
    { create: (id) => `/tmp/${id}`, remove: () => undefined },
  )
  for (const service of [agents, guidance, permissions, mcps, projects]) service.history.use(() => history)

  const realWriter = new CatalogWriter({
    guidance,
    permissions,
    mcps,
    projects,
    agents: { catalog: agents, rules: async () => TEST_AGENT_RULES, issues: () => [], defaultAgentId: async () => undefined, removed: (id) => guidance.removeAgent(id) },
  })
  const writer = options.wrapWriter ? options.wrapWriter(realWriter) : realWriter
  const planner = new CatalogImportPlanner({ reader, agentRules: async () => ({ ...TEST_AGENT_RULES, agentExists }), mcpSecrets: mcps })
  let ids = 0
  const newId = options.newId ?? (() => `lote-${++ids}`)
  const applier = new CatalogImportApplier({ planner, repository, history, reader, writer, newId })
  const restore = new CatalogRestoreUseCase({ repository, history, reader, writer, newId })
  return { repos, repository, reader, history, secrets, agents, guidance, permissions, mcps, projects, writer, planner, applier, restore }
}

export type TCatalogStack = ReturnType<typeof buildCatalogStack>
