import { installationRules, makePermissions } from './Permissions.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { callbackAllowed } from '@infra/http/Turn.Callbacks'
import { SecretMaskController } from '@infra/http/SecretMask.Controller'
import { makeSecretMasker } from './SecretMask.Factory'
import { backgroundProcesses } from '@infra/tools/Background.Processes'
import { ProjectAccountsController } from '@infra/http/ProjectAccounts.Controller'
import { PermissionsController } from '@infra/http/Permissions.Controller'
import { SchedulesController } from '@infra/http/Schedules.Controller'
import { makeScheduleRunner, makeSchedules } from './Schedules.Factory'
import { dockerStatus } from '@infra/sandbox/Docker.Sandbox'
import { GuidanceController } from '@infra/http/Guidance.Controller'
import { makeGuidance } from './Guidance.Factory'
import { SubscriptionLogins } from '@infra/providers/Subscription.Client'
import { McpProxyController } from '@infra/http/McpProxy.Controller'
import { makeMcpServers } from './McpServers.Factory'
import { McpServersController } from '@infra/http/McpServers.Controller'
import { PackagesController } from '@infra/http/Packages.Controller'
import { HooksController } from '@infra/http/Hooks.Controller'
import { makeHooks } from './Hooks.Factory'
import { makeProjects } from './Projects.Factory'
import { projectSandbox } from '@infra/sandbox/Project.Sandbox'
import { ProjectsController } from '@infra/http/Projects.Controller'
import { ImportController } from '@infra/http/Import.Controller'
import { catalogFinder, ImportScanUseCase } from '@application/ImportScan.Usecase'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { AgentController } from '@infra/http/Agent.Controller'
import { AuthController } from '@infra/http/Auth.Controller'
import { ProvidersController } from '@infra/http/Providers.Controller'
import { UsageController } from '@infra/http/Usage.Controller'
import { makeCredentials } from './Credentials.Factory'
import { makeProviders } from './Providers.Factory'
import { makeModelCatalog } from './Catalog.Factory'
import { providerBench } from './Orchestrator.Factory'
import { makeTools } from './Tools.Factory'
import { loadPricing } from '@infra/pricing/Pricing.File'
import { sessionContextFromEnv } from '@infra/session/Template.SessionContext'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeSettings } from './Settings.Factory'
import { makeUsecases } from './Usecases.Factory'

export function makeController(): AgentController {
  const usecases = makeUsecases()
  const { catalog } = makeTools()

  const controller = new AgentController({
    catalog,
    proof: makeAuth().proof,
    settings: makeSettings(),
    agents: makeAgents(),
    providers: makeProviders(),
    models: makeModelCatalog(),
    sessionContext: sessionContextFromEnv(),
    conversations: usecases.conversations,
    events: usecases.events,
    live: usecases.live,
    bench: providerBench(),
    pricing: loadPricing(),
    createSession: usecases.createSessionUseCase,
    sendMessage: usecases.sendMessageUseCase,
    cancelSession: usecases.cancelSessionUseCase,
    reconfigureSession: usecases.reconfigureSessionUseCase,
    deleteSession: usecases.deleteSessionUseCase,
    getSession: usecases.getSessionUseCase,
    listSessions: usecases.listSessionsUseCase,
    resumeSession: usecases.resumeSessionUseCase,
    agentRemoved: (agentId) => {
      makeHooks().removeAgent(agentId)
      makeGuidance().removeAgent(agentId)
      makeSchedules().removeAgent(agentId)
    },
    projects: makeProjects(),
    sandbox: projectSandbox(),
    docker: () => dockerStatus(),
    guidance: makeGuidance(),
    repositoryAllowed: (agentId, projectId, repository) => makePermissions().test({ agentId, projectId }, { category: 'repository', value: repository }).allowed,
    callbackAllowed: (url) => callbackAllowed(url),
    sessionEnded: (sessionId) => backgroundProcesses().stopSession(sessionId),
  })
  // O rascunho de agente do construtor é conferido com as MESMAS regras do cadastro, que moram aqui.
  makeGuidance().useAgentChecker((agent) => controller.agentDraftIssues(agent))
  makeGuidance().useSkillFilter(
    (agentId, projectId, skillId) =>
      makePermissions().test({ ...(agentId ? { agentId } : {}), ...(projectId ? { projectId } : {}) }, { category: 'skill', value: skillId }).allowed,
  )
  return controller
}

export function makeSchedulesController(): SchedulesController {
  return new SchedulesController({
    schedules: makeSchedules(),
    runner: makeScheduleRunner(),
    agentProject: (agentId) => makeAgents().get(agentId)?.projectId,
    proof: makeAuth().proof,
  })
}

export function makePermissionsController(): PermissionsController {
  return new PermissionsController({
    permissions: makePermissions(),
    projectExists: (projectId) => makeProjects().exists(projectId),
    agentExists: (agentId) => !!makeAgents().get(agentId),
    installationRules: () => installationRules(),
    proof: makeAuth().proof,
  })
}

export function makeProjectAccountsController(): ProjectAccountsController {
  return new ProjectAccountsController({
    accounts: makeProjectAccounts(),
    projectExists: (projectId) => makeProjects().exists(projectId),
    proof: makeAuth().proof,
  })
}

export function makeSecretMaskController(): SecretMaskController {
  return new SecretMaskController({ masker: makeSecretMasker(), proof: makeAuth().proof })
}

export function makeAuthController(): AuthController {
  const { accounts, proof, accessTokens } = makeAuth()
  return new AuthController({ accounts, proof, accessTokens })
}

export function makeProvidersController(): ProvidersController {
  return new ProvidersController({
    providers: makeProviders(),
    credentials: makeCredentials(),
    agents: makeAgents(),
    models: makeModelCatalog(),
    proof: makeAuth().proof,
    logins: new SubscriptionLogins(),
  })
}

export function makeUsageController(conversations: AgentController['conversations']): UsageController {
  return new UsageController({ conversations, proof: makeAuth().proof, models: makeModelCatalog(), accounts: makeAuth().accounts })
}

export function makeMcpServersController(): McpServersController {
  const { mcp } = makeTools()
  return new McpServersController({ service: makeMcpServers(), registry: mcp, proof: makeAuth().proof, projects: makeProjects() })
}

export function makeMcpProxyController(): McpProxyController {
  const { mcp } = makeTools()
  return new McpProxyController({ registry: mcp, proof: makeAuth().proof, session: (id) => mcp.session(id), agent: (id) => makeAgents().entry(id)?.agent })
}

export function makePackagesController(): PackagesController {
  return new PackagesController({ proof: makeAuth().proof })
}

export function makeHooksController(): HooksController {
  return new HooksController({ hooks: makeHooks(), proof: makeAuth().proof, sessionFor: (userId) => makeAuth().accounts?.sessionForHook(userId) })
}

export function makeProjectsController(): ProjectsController {
  return new ProjectsController({ projects: makeProjects(), proof: makeAuth().proof })
}

export function makeGuidanceController(): GuidanceController {
  return new GuidanceController({ guidance: makeGuidance(), proof: makeAuth().proof })
}

/** O importador: a varredura lê o repositório DO projeto (`resolveWorkFolder`, a mesma contenção da conversa) e não grava. */
export function makeImportController(): ImportController {
  const projects = makeProjects()
  const guidance = makeGuidance()
  const masker = makeSecretMasker()
  const quietly = <T>(read: () => T): T | undefined => {
    try {
      return read()
    } catch {
      return undefined
    }
  }
  return new ImportController({
    scan: new ImportScanUseCase({
      readTree: (projectId, repository) => readRepoTree(resolveWorkFolder(projects.folderOf(projectId), repository).dir, { mask: (text) => masker.text(text) }),
      detectors: [new AgentsDirDetector(), new OpencodeDetector()],
      findInCatalog: catalogFinder({
        doc: (id) => quietly(() => guidance.doc(id)),
        resource: (id) => quietly(() => guidance.resource(id)),
        rules: (scope) => guidance.rules(scope),
        agent: (id) => makeAgents().get(id),
        mcpServer: (id) => !!makeTools().servers.get(id),
      }),
    }),
    projectExists: (projectId) => projects.exists(projectId),
    proof: makeAuth().proof,
  })
}
