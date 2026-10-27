import { SubscriptionLogins } from '@infra/providers/Subscription.Client'
import { McpProxyController } from '@infra/http/McpProxy.Controller'
import { McpServersService } from '@application/McpServers.Service'
import { McpServersController } from '@infra/http/McpServers.Controller'
import { PackagesController } from '@infra/http/Packages.Controller'
import { HooksController } from '@infra/http/Hooks.Controller'
import { makeHooks } from './Hooks.Factory'
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

  return new AgentController({
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
    agentRemoved: (agentId) => makeHooks().removeAgent(agentId),
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
