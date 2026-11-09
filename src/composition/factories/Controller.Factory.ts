import { RESOURCE_KINDS } from '@domain/models/Resource.Model'
import type { UsageCapService } from '@application/UsageCap.Service'
import { makeResourceSecrets } from './ResourceSecrets.Factory'
import { makeCatalogEvents } from './CatalogEvents.Factory'
import { readFileSync } from 'node:fs'
import { AsyncResource } from 'node:async_hooks'
import { join } from 'node:path'
import { installationRules, makePermissions } from './Permissions.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { callbackSecret } from '@infra/http/Turn.Callbacks'
import { SecretMaskController } from '@infra/http/SecretMask.Controller'
import { makeSecretMasker } from './SecretMask.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { backgroundProcesses } from '@infra/tools/Background.Processes'
import { ProjectAccountsController } from '@infra/http/ProjectAccounts.Controller'
import { PermissionsController } from '@infra/http/Permissions.Controller'
import { PermissionRequestsController } from '@infra/http/PermissionRequests.Controller'
import { makePermissionRequests } from './PermissionRequests.Factory'
import { LedgerController } from '@infra/http/Ledger.Controller'
import { makeLedger } from './Ledger.Factory'
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
import { CatalogImportApplier } from '@application/CatalogImport.Apply'
import { ImportApplyUseCase } from '@application/ImportApply.Usecase'
import { CatalogWriter } from '@application/Catalog.Writer'
import { isLaunchedMcp, mcpServerKey } from '@domain/models/McpServer.Model'
import { removeInstall } from '@infra/mcp/Mcp.Install'
import { catalogFinder, ImportScanUseCase } from '@application/ImportScan.Usecase'
import { ImportJobService } from '@application/ImportJob.Service'
import { ImportBatchService } from '@application/ImportBatch.Service'
import { readRepoBytes, readRepoTree } from '@infra/import/Repo.Tree'
import { AgentsDirDetector } from '@infra/import/AgentsDir.Detector'
import { AgenticToolsDetector } from '@infra/import/AgenticTools.Detector'
import { AgentsMdDetector } from '@infra/import/AgentsMd.Detector'
import { ClaudeDetector } from '@infra/import/Claude.Detector'
import { OpencodeDetector } from '@infra/import/Opencode.Detector'
import { resolveWorkFolder } from '@infra/workspace/Work.Folder'
import { AgentController } from '@infra/http/Agent.Controller'
import { AuthController } from '@infra/http/Auth.Controller'
import { ModelGroupRetirement } from '@application/ModelGroupRetirement.Service'
import { ProvidersController } from '@infra/http/Providers.Controller'
import { UsageController } from '@infra/http/Usage.Controller'
import { makeCredentials } from './Credentials.Factory'
import { makeProviders } from './Providers.Factory'
import { makeModelCatalog } from './Catalog.Factory'
import { makeSessionStore, providerBench } from './Orchestrator.Factory'
import { makeTools } from './Tools.Factory'
import { loadPricing } from '@infra/pricing/Pricing.File'
import { sessionContextFromEnv } from '@infra/session/Template.SessionContext'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { importJobRepository } from './ImportJobs.Factory'
import { makeSettings } from './Settings.Factory'
import { makeUsecases } from './Usecases.Factory'
import { makeImportBuild, makeImportRuns, readImportSource, useImportOpener, useImportTurns } from './ImportBuild.Factory'
import { BUILDER_METADATA_KEY } from '@domain/Builder.Agents'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { EMode } from '@domain/enums/EMode.Enum'
import { makeResourceFiles } from './ResourceFiles.Factory'

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
    // ⛔ No banco já ao abrir, não no primeiro turno: a tela do construtor lê a marca da importação da lista para mostrar o
    // "Começar", e o item fica ligado a esta conversa desde agora.
    await usecases.sendMessageUseCase.saveHeader(session.id)
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
    usageCap: usecases.usageCap,
    events: usecases.events,
    catalogEvents: makeCatalogEvents(),
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
      makeResourceSecrets().removeScope('agent', agentId)
    },
    projects: makeProjects(),
    sandbox: projectSandbox(),
    docker: () => dockerStatus(),
    guidance: makeGuidance(),
    secrets: makeResourceSecrets(),
    repositoryAllowed: (agentId, projectId, repository) => makePermissions().test({ agentId, projectId }, { category: 'repository', value: repository }).allowed,
    maskText: (text) => makeSecretMasker().text(text),
    callbackSecret: (url, projectId) => callbackSecret(url, projectId ? (host) => makeProjectAccounts().callbackSecret(projectId, host) : undefined),
    sessionEnded: (sessionId) => backgroundProcesses().stopSession(sessionId),
  })
  // ⛔ O turno de fundo do Importador amarrado ao contexto de quem pediu (a identidade da requisição): a fila roda depois,
  // e o turno passa pelas mesmas regras do `POST …/turns`.
  useImportTurns((conversationId, message) => AsyncResource.bind(() => controller.serverTurn(conversationId, message)))
  // A resposta de uma delegação que chegou depois do turno da mãe vira um turno novo dela, com as regras do `POST …/turns`.
  makeTools()
    .delegation.get()
    ?.useLateDelivery(
      (parentId, text) =>
        void controller
          .serverTurn(parentId, text)
          .catch((error: unknown) => console.warn('[delegação] a resposta atrasada não entrou:', error instanceof Error ? error.message : String(error))),
    )
  // O rascunho de agente do construtor é conferido com as MESMAS regras do cadastro, que moram aqui.
  makeGuidance().useAgentChecker((agent) => controller.agentDraftIssues(agent))
  agentController = controller
  makeGuidance().useSkillFilter(
    (agentId, projectId, skillId) =>
      makePermissions().test({ ...(agentId ? { agentId } : {}), ...(projectId ? { projectId } : {}) }, { category: 'skill', value: skillId }).allowed,
  )
  // O `patch_agent` e a aprovação de um patch gravam o agente inteiro: com as MESMAS regras do `PUT /agents`.
  makePermissionRequests().useAgentValidation(async () => ({ rules: await controller.agentRules(), issues: (agent) => controller.projectIssues(agent) }))
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

export function makePermissionRequestsController(): PermissionRequestsController {
  return new PermissionRequestsController({
    service: makePermissionRequests(),
    proof: makeAuth().proof,
    liveSession: (id) => makeSessionStore().get(id),
    secrets: makeResourceSecrets(),
    resourceKindOf: (id) => makeGuidance().resourceKindOf(id),
    // O projeto da skill ou do command (a variável dele é do admin desse projeto); sem recurso, `undefined`.
    resourceProjectOf: (id) => {
      if (!makeGuidance().resourceKindOf(id)) return undefined
      return makeGuidance().resource(id).projectId ?? null
    },
    resourceSharedWithOf: (id) => (makeGuidance().resourceKindOf(id) ? makeGuidance().resource(id).sharedWith : undefined),
    agentSharedWithOf: (id) => makeAgents().get(id)?.sharedWith,
  })
}

export function makeLedgerController(): LedgerController {
  return new LedgerController({ service: makeLedger(), proof: makeAuth().proof })
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

/** ⚠️ Uma só: lê as mesmas configurações e o mesmo catálogo que o resto. */
export function makeModelGroupRetirement(): ModelGroupRetirement {
  const providers = makeProviders()
  const models = makeModelCatalog()
  return new ModelGroupRetirement(makeSettings(), (provider, model) => providers.get(provider)?.enabled === true && models.isEnabled(provider, model))
}

export function makeProvidersController(): ProvidersController {
  return new ProvidersController({
    providers: makeProviders(),
    credentials: makeCredentials(),
    agents: makeAgents(),
    models: makeModelCatalog(),
    retire: (by) => makeModelGroupRetirement().retire(by),
    proof: makeAuth().proof,
    logins: new SubscriptionLogins(),
  })
}

export function makeUsageController(conversations: AgentController['conversations'], cap?: UsageCapService): UsageController {
  return new UsageController({ conversations, proof: makeAuth().proof, models: makeModelCatalog(), accounts: makeAuth().accounts, cap })
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
  return new GuidanceController({
    guidance: makeGuidance(),
    proof: makeAuth().proof,
    files: makeResourceFiles(),
    agentFiles: (agentId, files, by, base) => makeAgents().saveFiles(agentId, files, by, base),
    resourceRemoved: (kind, id) => makeResourceSecrets().removeScope(kind, id),
    projectDir: (projectId) => (makeProjects().exists(projectId) ? makeProjects().folderOf(projectId) : undefined),
    agentFilesOf: (agentId) => {
      const agent = makeAgents().entry(agentId)?.agent
      return agent ? { files: agent.files ?? [], ...(agent.projectId ? { projectId: agent.projectId } : {}) } : undefined
    },
    fileOwners: (sha256) => {
      const owners: Array<string | null> = []
      const guidance = makeGuidance()
      for (const scope of [
        null,
        ...makeProjects()
          .all()
          .map((project) => project.id),
      ])
        for (const kind of RESOURCE_KINDS) if (guidance.resources(scope, kind).some((resource) => resource.files?.some((file) => file.sha256 === sha256))) owners.push(scope)
      for (const agent of makeAgents().list()) if (agent.files?.some((file) => file.sha256 === sha256)) owners.push(agent.projectId ?? null)
      return owners
    },
    secretsIn: (text) =>
      makeSecretMasker()
        .scan(text)
        .hits.map((hit) => hit.label),
  })
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
    importApplier: makeCatalogImportApplier(),
    batches: catalogHistoryParts().repository,
  })
}

/**
 * Aplicar o import: o MESMO plano (recalculado) e o MESMO escritor do rollback — os serviços de cada tipo, com as
 * validações e os efeitos das rotas de sempre —, num lote do histórico.
 */
export function makeCatalogImportApplier(): CatalogImportApplier {
  const { repository, reader } = catalogHistoryParts()
  return new CatalogImportApplier({ planner: makeCatalogImportPlanner(), repository, history: makeCatalogHistory(), reader, writer: makeCatalogWriter() })
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
  const { repository, reader } = catalogHistoryParts()
  return new CatalogRestoreUseCase({ repository, history: makeCatalogHistory(), reader, writer: makeCatalogWriter() })
}

/** O escritor do catálogo (rollback e import): o documento canônico de volta pelos serviços de cada tipo. */
function makeCatalogWriter(): CatalogWriter {
  const agents = () => agentController ?? makeController()
  const { mcp } = makeTools()
  return new CatalogWriter({
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
}

/** Onde o importador confere se a conversa de um item existe: o banco das conversas (uma conexão a mais no mesmo arquivo). */
let importConversations: IConversationRepository | undefined

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
    readTree: (projectId, repository) => {
      const folder = resolveWorkFolder(projects.folderOf(projectId), repository)
      return readRepoTree(folder.dir, { mask: (text) => masker.text(text), git: folder })
    },
    detectors: [new AgentsDirDetector(), new OpencodeDetector(), new AgentsMdDetector(), new ClaudeDetector(), new AgenticToolsDetector()],
    projectIgnore: (projectId) => projects.importIgnore(projectId),
    projectScope: (projectId) => projects.importScope(projectId),
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
    runs: makeImportRuns(),
    batches: new ImportBatchService({ repository: importJobRepository(), catalogState: (query) => scan.catalogState(query) }),
    // ⛔ A gravação pelo catálogo: o MESMO plano e o MESMO apply do import do catálogo (um caminho de escrita só).
    apply: new ImportApplyUseCase({
      repository: importJobRepository(),
      readSource: readImportSource,
      scan,
      catalog: makeCatalogImportApplier(),
      reader: catalogHistoryParts().reader,
      models: () =>
        makeProviders()
          .list()
          .filter((provider) => provider.enabled)
          .map((provider) => ({ provider: provider.id, protocol: provider.protocol, models: makeModelCatalog().enabledIds(provider.id) }))
          .filter((entry) => entry.models.length > 0),
      // Os arquivos de recurso (scripts da skill e do agente): byte a byte, conferidos, para o depósito.
      readRaw: (projectId, repository, path) => {
        try {
          return readRepoBytes(resolveWorkFolder(projects.folderOf(projectId), repository).dir, path)
        } catch {
          return undefined
        }
      },
      files: makeResourceFiles(),
      secretsIn: (text) =>
        makeSecretMasker()
          .scan(text)
          .hits.map((hit) => hit.label),
    }),
    projectExists: (projectId) => projects.exists(projectId),
    conversationExists: async (conversationId) => {
      importConversations ??= makeConversationRepository()
      // Sem banco (`CONVERSATIONS_DB=off`) nada se perde por não estar nele: não marca.
      if (importConversations instanceof NullConversationRepository) return true
      return !!(await importConversations.findSession(conversationId))
    },
    ignore: { get: (projectId) => projects.importIgnore(projectId), set: (projectId, patterns, by) => projects.setImportIgnore(projectId, patterns, by) },
    scope: { get: (projectId) => projects.importScope(projectId), set: (projectId, scope, by) => projects.setImportScope(projectId, scope, by) },
    proof: makeAuth().proof,
  })
}
