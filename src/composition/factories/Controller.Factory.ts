import { SchedulesController } from '@infra/http/Schedules.Controller'
import { makeScheduleRunner, makeSchedules } from './Schedules.Factory'
import { dockerStatus } from '@infra/sandbox/Docker.Sandbox'
import { GuidanceController } from '@infra/http/Guidance.Controller'
import { makeGuidance } from './Guidance.Factory'
import { SubscriptionLogins } from '@infra/providers/Subscription.Client'
import { McpProxyController } from '@infra/http/McpProxy.Controller'
import { McpServersService } from '@application/McpServers.Service'
import { McpServersController } from '@infra/http/McpServers.Controller'
import { PackagesController } from '@infra/http/Packages.Controller'
import { HooksController } from '@infra/http/Hooks.Controller'
import { makeHooks } from './Hooks.Factory'
import { makeProjects } from './Projects.Factory'
import { projectSandbox } from '@infra/sandbox/Project.Sandbox'
import { ProjectsController } from '@infra/http/Projects.Controller'
import { AgentController } from '@infra/http/Agent.Controller'
import { AuthController } from '@infra/http/Auth.Controller'
import { ProvidersController } from '@infra/http/Providers.Controller'
import { UsageController } from '@infra/http/Usage.Controller'
import { makeCredentials } from './Credentials.Factory'
import { makeProviders } from './Providers.Factory'
import { makeModelCatalog } from './Catalog.Factory'
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
  })
  // O rascunho de agente do construtor é conferido com as MESMAS regras do cadastro, que moram aqui.
  makeGuidance().useAgentChecker((agent) => controller.agentDraftIssues(agent))
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
  const { mcp, servers } = makeTools()
  return new McpServersController({
    service: new McpServersService(servers, makeCredentials(), () =>
      makeAgents()
        .rawEntries()
        .map((entry) => entry.agent),
    ),
    registry: mcp,
    proof: makeAuth().proof,
  })
}

export function makeMcpProxyController(): McpProxyController {
  const { mcp } = makeTools()
  return new McpProxyController({ registry: mcp, proof: makeAuth().proof, session: (id) => mcp.session(id), agentTools: (id) => makeAgents().entry(id)?.agent.allowedTools })
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
