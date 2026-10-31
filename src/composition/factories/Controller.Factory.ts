import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { CatalogController } from '@infra/http/Catalog.Controller'
import { catalogHistoryParts, makeCatalogHistory, makeCatalogHistoryQuery } from './CatalogHistory.Factory'
import { CatalogRestoreUseCase } from '@application/CatalogRestore.Usecase'
import { CatalogExportUseCase } from '@application/CatalogExport.Usecase'
import { CatalogImportPlanner } from '@application/CatalogImport.Plan'
import { CatalogWriter } from '@application/Catalog.Writer'
import { isLaunchedMcp, mcpServerKey } from '@domain/models/McpServer.Model'
import { removeInstall } from '@infra/mcp/Mcp.Install'
import { catalogFinder, ImportScanUseCase } from '@application/ImportScan.Usecase'
import { ImportJobService } from '@application/ImportJob.Service'
import { ImportBatchService } from '@application/ImportBatch.Service'
import { readRepoTree } from '@infra/import/Repo.Tree'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { AgentsMdDetector } from '@infra/import/AgentsMd.Detector'
import { ClaudeDetector } from '@infra/import/Claude.Detector'
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
import { importJobRepository } from './ImportJobs.Factory'
import { makeSettings } from './Settings.Factory'
import { makeUsecases } from './Usecases.Factory'
import { makeImportBuild, useImportOpener } from './ImportBuild.Factory'
import { BUILDER_METADATA_KEY } from '@domain/Builder.Agents'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { EMode } from '@domain/enums/EMode.Enum'

/** O último controller de agentes montado: as regras do cadastro de agente moram nele (o rollback as usa). */
let agentController: AgentController | undefined

export function makeController(): AgentController {
  const usecases = makeUsecases()
  const { catalog } = makeTools()
  // ⛔ A conversa do construtor em modo importação nasce pelos MESMOS casos de uso das conversas, com as marcas que só o
  // servidor escreve: o dono, o projeto, a construção (fora da caixa de entrada) e a importação.
  useImportOpener(async (input) => {
    const session = await usecases.createSessionUseCase.execute({
      agentId: input.agentId,
      mode: EMode.AGENT,
      adminAccess: true,
      metadata: { ...input.metadata, ...(input.owner ? { owner: input.owner } : {}), [PROJECT_METADATA_KEY]: input.projectId, [BUILDER_METADATA_KEY]: input.kind },
    })
    return session.id
  })

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
  agentController = controller
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

/** O histórico do catálogo: admin lê tudo, faz o rollback e exporta; o membro, só lê o MCP dos projetos dele. */
export function makeCatalogController(): CatalogController {
  return new CatalogController({
    history: makeCatalogHistoryQuery(),
    proof: makeAuth().proof,
    projects: makeProjects(),
    restore: makeCatalogRestore(),
    exporter: makeCatalogExport(),
    importPlanner: makeCatalogImportPlanner(),
  })
}

/**
 * O plano de import (dry-run): o MESMO leitor do histórico, as regras do cadastro de agente do controller de agentes e
 * o cofre dos MCPs (só "configurado ou não"). ⛔ Nada grava.
 */
function makeCatalogImportPlanner(): CatalogImportPlanner {
  const agents = () => agentController ?? makeController()
  return new CatalogImportPlanner({ reader: catalogHistoryParts().reader, agentRules: () => agents().agentRules(), mcpSecrets: makeMcpServers() })
}

/** O export: o MESMO leitor do histórico e a MESMA máscara de segredos do gateway (valores conhecidos e nomes da tela). */
function makeCatalogExport(): CatalogExportUseCase {
  const version = gatewayVersion()
  return new CatalogExportUseCase({ reader: catalogHistoryParts().reader, mask: makeSecretMasker(), ...(version ? { version } : {}) })
}

/** A versão do `package.json` da raiz (o mesmo nível em `src/` e em `dist/`); sem ele, o manifesto sai sem versão. */
function gatewayVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
}

/**
 * O rollback do catálogo: o documento volta pelos MESMOS serviços (e com os mesmos efeitos colaterais) das rotas de
 * cada tipo — as regras do agente são as do controller de agentes; o MCP fecha a instância de pé e, ao sair, leva
 * cliente e pacote.
 */
function makeCatalogRestore(): CatalogRestoreUseCase {
  const agents = () => agentController ?? makeController()
  const { mcp } = makeTools()
  const { repository, reader } = catalogHistoryParts()
  const writer = new CatalogWriter({
    guidance: makeGuidance(),
    permissions: makePermissions(),
    mcps: makeMcpServers(),
    projects: makeProjects(),
    agents: {
      catalog: makeAgents(),
      rules: () => agents().agentRules(),
      issues: (agent) => agents().projectIssues(agent),
      defaultAgentId: async () => (await makeSettings().read()).agentId,
      removed: (agentId) => {
        makeHooks().removeAgent(agentId)
        makeGuidance().removeAgent(agentId)
        makeSchedules().removeAgent(agentId)
      },
    },
    mcpChanged: async (server) => {
      if (isLaunchedMcp(server)) await mcp.closeInstances({ serverId: mcpServerKey(server) })
    },
    mcpRemoved: async (server) => {
      const key = mcpServerKey(server)
      mcp.forget(key)
      await mcp.closeInstances({ serverId: key })
      if (server.kind === 'process') removeInstall(key)
    },
  })
  return new CatalogRestoreUseCase({ repository, history: makeCatalogHistory(), reader, writer })
}

/**
 * O importador: a varredura lê o repositório DO projeto (`resolveWorkFolder`, a mesma contenção da conversa); o
 * trabalho de importação a salva com o estado de cada item. ⛔ Nada grava no catálogo.
 */
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
  const scan = new ImportScanUseCase({
    readTree: (projectId, repository) => readRepoTree(resolveWorkFolder(projects.folderOf(projectId), repository).dir, { mask: (text) => masker.text(text) }),
    detectors: [new AgentsDirDetector(), new OpencodeDetector(), new AgentsMdDetector(), new ClaudeDetector()],
    projectIgnore: (projectId) => projects.importIgnore(projectId),
    findInCatalog: catalogFinder({
      doc: (id) => quietly(() => guidance.doc(id)),
      resource: (id) => quietly(() => guidance.resource(id)),
      rules: (scope) => guidance.rules(scope),
      agent: (id) => makeAgents().get(id),
      mcpServer: (id) => !!makeTools().servers.get(id),
    }),
  })
  return new ImportController({
    scan,
    jobs: new ImportJobService({ repository: importJobRepository(), scan: (projectId, repository, options) => scan.execute(projectId, repository, options) }),
    build: makeImportBuild(),
    batches: new ImportBatchService({ repository: importJobRepository(), catalogState: (query) => scan.catalogState(query) }),
    projectExists: (projectId) => projects.exists(projectId),
    ignore: { get: (projectId) => projects.importIgnore(projectId), set: (projectId, patterns, by) => projects.setImportIgnore(projectId, patterns, by) },
    proof: makeAuth().proof,
  })
}
