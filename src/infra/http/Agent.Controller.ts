import { CAPABILITIES, CAPABILITY_PREFIX, CAPABILITY_TOOLS, capability, capabilityRuns, toCapabilities } from '@domain/Capability.Catalog'
import { agentUnavailable, IAvailabilityFacts, TAgentUnavailable, targetUnavailable, UNAVAILABLE_LABEL } from '@domain/Agent.Availability'
import { clientMetadata } from '@domain/Session.Metadata'
import { metaPlaceholderKeys } from '@infra/sandbox/Egress.Proxy'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { ResumeSessionUseCase } from '@application/ResumeSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { aggregateTurn } from '@application/Turn.Aggregator'
import { randomBytes, randomUUID } from 'node:crypto'
import { AgentCatalog } from '@application/Agent.Catalog'
import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { agentIssues, IAgentRules, offers, targetFor } from '@domain/Agent.Policy'
import { NATIVE_TOOLS } from '@domain/Native.Tools'
import { dangerousToolsOf } from '@domain/Tool.Policy'
import { isSubscription } from '@domain/Subscription.Policy'
import { delegationMaxDepth } from '@domain/models/Delegation.Model'
import { mcpServerKey, mcpServesProject } from '@domain/models/McpServer.Model'
import { compactAtPercent } from '@domain/Compaction.Policy'
import { loopLimits } from '@domain/Loop.Policy'
import { maxOutputTokens, maxToolTurns } from '@infra/adapters/support/Prompt.Helper'
import { bashPolicy } from '@infra/tools/Bash.Guard'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { diagnosticsOn, IAgent, IAgentTarget } from '@domain/models/Agent.Model'
import { AgentUnavailableError } from '@domain/errors/Domain.Error'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { toSharedConversation } from '@domain/models/Conversation.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { allowsCaller, mergeSettings } from '@domain/models/Settings.Model'
import { LIMIT_BOUNDS, liveLimit } from '@domain/models/Limits.Model'
import { IConversationEvents, TConversationEvent } from '@domain/ports/ConversationEvents.Port'
import { ITurnLive } from '@domain/ports/TurnLive.Port'
import { IProviderDirectory } from '@domain/ports/ProviderRepository.Port'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { ISessionContextProvider } from '@domain/ports/SessionContextProvider.Port'
import { SessionBusyError, SessionNotFoundError } from '@domain/errors/Domain.Error'
import { IProjectCaller, ProjectsService } from '@application/Projects.Service'
import { agentFootprint } from '@application/Agent.Footprint'
import { caller as currentCaller } from '@infra/mcp/Caller.Identity'
import { GuidanceService } from '@application/Guidance.Service'
import { IDockerStatus } from '@infra/sandbox/Docker.Sandbox'
import { IProjectSandbox } from '@infra/sandbox/Project.Sandbox'
import { CALLBACK_METADATA_KEY, PROJECT_METADATA_KEY, REPOSITORY_METADATA_KEY, START_COMMIT_METADATA_KEY, WORKTREE_METADATA_KEY } from '@domain/Session.Metadata'
import { CHANGE_SCOPES, changesOf, fileDiff, headOf, TChangeScope } from '@infra/workspace/Git.Changes'
import { projectWorkspacePath } from '@infra/adapters/support/Subscription.Workspace'
import { currentBranch, IWorkFolder, resolveWorkFolder, WorkFolderError } from '@infra/workspace/Work.Folder'
import { deliverCallback } from './Turn.Callbacks'
import { BUILDER_METADATA_KEY, builderKindOf, CORE_AGENT_IDS } from '@domain/Builder.Agents'
import { IAgentProviderFacts, toAgentDetailDto, toAgentDto } from './Agent.Dto'
import { assertNoAdkTemplateCollision } from '@infra/adapters/GoogleAgent.Adapter'
import { IConversationView, toConversationDto, toStatsDto, toTurnDto } from './Conversation.Dto'
import { metadataFilter, parsePageQuery } from './Monitor.Query'
import { IResolvedCaller, ownerOf, ownsSession, resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { audienceRules } from './Caller.Roles'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import {
  agentBodySchema,
  createSessionSchema,
  followTurnSchema,
  sendMessageSchema,
  shareConversationSchema,
  TAgentBody,
  updateSettingsSchema,
  reconfigureSessionSchema,
} from './Request.Schema'
import { toSessionDto } from './Session.Dto'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { SseStream } from './Sse.Stream'
import { NextFunction, Request, Response } from 'express'

/**
 * As tools LOCAIS que um agente PODE receber — o perímetro, decidido no deploy.
 *
 * ⛔ `LOCAL_TOOLS_ENABLED` (lista separada por vírgula) é o perímetro, e a tela não o amplia: tirar o
 * `run_bash` dali tira o `run_bash` do gateway, para qualquer agente criado ou editado. Sem a variável,
 * todas as locais.
 */
export function localToolPerimeter(all: readonly string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const declared = env.LOCAL_TOOLS_ENABLED?.split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (declared?.length) return all.filter((name) => declared.includes(name))
  return [...all]
}
const STARTED_AT = Date.now()

export interface IAgentControllerDeps {
  /** Injetado, e não buscado no singleton da composição: é o que torna o controller testável sem rede. */
  catalog: ToolCatalog
  createSession: CreateSessionUseCase
  sendMessage: SendMessageUseCase
  cancelSession: CancelSessionUseCase
  reconfigureSession: ReconfigureSessionUseCase
  deleteSession: DeleteSessionUseCase
  getSession: GetSessionUseCase
  listSessions: ListSessionsUseCase
  /** Retoma a conversa gravada cuja sessão expirou ou caiu num reinício. Ausente = a sessão morta fica morta (404). */
  resumeSession?: ResumeSessionUseCase
  /**
   * A estratégia que prova a credencial. Ausente = prova desligada: a identidade é só afirmada, e
   * o que exige identidade PROVADA recusa (ver `resolveCaller`).
   */
  proof?: ICallerProof
  /**
   * As configurações de operação. O MESMO repositório que o provider escuta (ver `makeSettings`):
   * com duas instâncias, a tela salvaria numa e o provider leria a outra.
   */
  settings: ISettingsRepository
  /** Escreve o contexto que abre a conversa. Ausente = nenhum contexto. */
  sessionContext?: ISessionContextProvider
  /**
   * O MESMO repositório em que o `SendMessageUseCase` grava (ver `makeUsecases`): com dois, a tela
   * leria um arquivo e o turno seria gravado no outro.
   */
  conversations: IConversationRepository
  /** A tabela de preços ativa (de fábrica + `MODEL_PRICING_FILE`). Ausente = a de fábrica. */
  pricing?: TModelPricing
  /** Por onde chegam as mudanças nas conversas gravadas. Ausente = `/conversations/events` só mantém a conexão. */
  events?: IConversationEvents
  /** Os provedores sem cota agora (ver `Provider.Bench`), para a tela de configurações. */
  bench?: { list(): Array<{ provider: string; until: Date }> }
  /** O turno ao vivo (ver `Turn.Live`). Ausente = `/sessions/:id/live` só mantém a conexão. */
  live?: ITurnLive
  /** O agente foi apagado: o que é dele e mora fora do cadastro (os hooks) vai junto. */
  agentRemoved?: (agentId: string) => void
  /** Os projetos e quem é membro. Ausente = sem projetos (tudo como antes: um espaço só). */
  projects?: ProjectsService
  /** O cerco dos agentes de projeto, para a tela mostrar se funciona neste servidor. */
  sandbox?: IProjectSandbox
  /** O Docker responde aqui? (o MCP "Contêiner isolado" precisa dele). Ausente = não se informa. */
  docker?: () => Promise<IDockerStatus>
  /** As rules e os documentos — o que o ambiente põe no prompt (a guia Tamanho do agente pesa). Ausente = nada. */
  guidance?: GuidanceService
  /** Os providers configurados — para o agente apontar para um que existe. Ausente = só os oficiais. */
  providers?: IProviderDirectory
  /** O catálogo de modelos: preços por provider, e os modelos que um agente pode oferecer. */
  models?: ModelCatalogService
  /** Os agentes do banco: o MESMO catálogo do provider (ver `makeAgents`). */
  agents: AgentCatalog
  /** O agente pode ser ativado neste repositório do projeto (permissão `repository`)? Ausente = sim. */
  repositoryAllowed?: (agentId: string, projectId: string, repository: string) => boolean
  /** A conversa foi apagada: o que roda por ela (os processos em segundo plano) para. */
  sessionEnded?: (sessionId: string) => void
  /** O aviso de fim de turno pode ir para este endereço (`TURN_CALLBACK_HOSTS`)? Ausente = nunca. */
  callbackAllowed?: (url: string) => boolean
}

/**
 * O id do LINK público: 12 bytes aleatórios em base64url (16 caracteres, 96 bits), sem prefixo de
 * provider.
 *
 * ⚖️ Curto porque uma pessoa vê e cola; imprevisível porque É o segredo do link.
 */
function newShareId(): string {
  return randomBytes(12).toString('base64url')
}

/** Conversas vivas por conta (configurações, senão `SESSIONS_PER_OWNER`, padrão 50). Anônimos contam como uma conta só. */
function sessionsPerOwner(): number {
  return liveLimit('sessionsPerOwner') ?? (Number(process.env.SESSIONS_PER_OWNER) || 50)
}

/** Streams de eventos abertos por conta (configurações, senão `STREAMS_PER_OWNER`, padrão 20). */
function streamsPerOwner(): number {
  return liveLimit('streamsPerOwner') ?? (Number(process.env.STREAMS_PER_OWNER) || 20)
}

/** Um turno assíncrono rodando: o que já saiu, para o `GET` do estado. */
interface ILiveTurn {
  turn: number
  startedAt: number
  text: string
  tools: string[]
}

export class AgentController {
  /** Os turnos assíncronos rodando (por conversa) e o resultado do último de cada uma, até o gravado chegar. */
  private readonly liveTurns = new Map<string, ILiveTurn>()
  private readonly finishedTurns = new Map<string, Record<string, unknown> & { turn: number }>()

  constructor(private readonly usecases: IAgentControllerDeps) {
    this.health = this.health.bind(this)
    this.getAgents = this.getAgents.bind(this)
    this.getAgentTools = this.getAgentTools.bind(this)
    this.getAgentFootprint = this.getAgentFootprint.bind(this)
    this.getAgentCommands = this.getAgentCommands.bind(this)
    this.getTools = this.getTools.bind(this)
    this.createSession = this.createSession.bind(this)
    this.listSessions = this.listSessions.bind(this)
    this.getSession = this.getSession.bind(this)
    this.deleteSession = this.deleteSession.bind(this)
    this.sendMessage = this.sendMessage.bind(this)
    this.startTurn = this.startTurn.bind(this)
    this.turnStatus = this.turnStatus.bind(this)
    this.changes = this.changes.bind(this)
    this.cancelSession = this.cancelSession.bind(this)
    this.reconfigureSession = this.reconfigureSession.bind(this)
    this.compactSession = this.compactSession.bind(this)
    this.guardCaller = this.guardCaller.bind(this)
    this.availability = this.availability.bind(this)
    this.getSettings = this.getSettings.bind(this)
    this.updateSettings = this.updateSettings.bind(this)
    this.listConversations = this.listConversations.bind(this)
    this.conversationStats = this.conversationStats.bind(this)
    this.getConversationTurns = this.getConversationTurns.bind(this)
    this.getConversationTodos = this.getConversationTodos.bind(this)
    this.shareConversation = this.shareConversation.bind(this)
    this.deleteConversation = this.deleteConversation.bind(this)
    this.getSharedConversation = this.getSharedConversation.bind(this)
    this.conversationEvents = this.conversationEvents.bind(this)
    this.sessionLive = this.sessionLive.bind(this)
    this.followTurn = this.followTurn.bind(this)
    this.getAgent = this.getAgent.bind(this)
    this.createAgent = this.createAgent.bind(this)
    this.updateAgent = this.updateAgent.bind(this)
    this.deleteAgent = this.deleteAgent.bind(this)
    this.agents = usecases.agents
  }

  private readonly agents: AgentCatalog
  /** Streams de eventos abertos por conta (ver `conversationEvents`). */
  private readonly openStreams = new Map<string, number>()
  /** Os streams da caixa de entrada abertos agora, pelo id que cada um recebeu ao conectar (ver `followTurn`). */
  private readonly inboxStreams = new Map<string, { owner: string; emit: (type: string, data: object) => void; unfollow?: () => void }>()

  /** O repositório das conversas — o mesmo do `SendMessageUseCase`; o uso (`UsageController`) lê dele. */
  get conversations(): IConversationRepository {
    return this.usecases.conversations
  }

  async health(_req: Request, res: Response) {
    await this.respond(res, async () => {
      // ⛔ Rota pública e BARATA: sem reconectar MCP (cada chamada abria conexão com todos os servidores
      // — amplificação de graça para quem martelar) e sem contagens. O detalhe é só para admin.
      if (!(await checkAdminAccess(this.usecases.proof)).allowed) return { status: 'ok' }

      void this.usecases.catalog.mcp.connectAll()
      const servers = this.usecases.catalog.mcp.status().filter((server) => server.enabled)
      return {
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
        mcp: { connected: servers.some((server) => server.connected), servers: servers.length },
        sessions: (await this.usecases.listSessions.execute()).length,
      }
    })
  }

  /**
   * Portão das rotas que não são do controller (o `openapi.json`): mesma regra de identidade, como
   * middleware. Recusa com 401 pelo handler de erro do servidor.
   */
  async guardCaller(_req: Request, _res: Response, next: NextFunction) {
    try {
      if (!(await resolveCaller(this.usecases.proof))) throw unauthorized()
      next()
    } catch (error: unknown) {
      next(error)
    }
  }

  /**
   * ⛔ SÓ O QUE ESTÁ ATIVO para quem não administra: agente com provider desligado, sem modelo, sem chave
   * ou que exige admin não aparece — antes aparecia, e falhava só ao abrir a conversa. O admin vê todos,
   * cada inativo com o motivo (`unavailable`), para saber o que ligar.
   */
  async getAgents(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()
      const admin = (await checkAdminAccess(this.usecases.proof)).allowed
      const caller = { userId: resolved.identity?.id, admin }
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      if (project) this.requireProject(caller, project)
      return (
        this.agents
          .entries()
          // ⛔ Com `?project`, os dele e os globais. Sem, tudo o que a pessoa pode usar (os globais e os dos projetos dela).
          .filter((entry) => this.agentVisible(entry.agent, caller, project))
          .map((entry) => ({ entry, unavailable: this.unavailableOf(entry.agent, admin) }))
          .filter(({ unavailable }) => admin || !unavailable)
          .map(({ entry, unavailable }) => ({
            // ⛔ Quem não administra só vê os providers que rodam para ele: um desligado não é escolha.
            ...this.listedAgent(entry.agent, admin),
            ...(unavailable ? { unavailable: { reason: unavailable, label: UNAVAILABLE_LABEL[unavailable] } } : {}),
          }))
      )
    })
  }

  /** O que as configurações novas apontam e não está ativo: agente, modelo do agente, classificador. */
  private async settingsIssues(body: {
    agentId?: string | null
    provider?: string | null
    model?: string | null
    classifierModel?: string | null
    classifierProvider?: string | null
    builderProvider?: string | null
    builderModel?: string | null
    fallback?: { chain: Array<{ provider: string; model: string }> } | null
  }) {
    const issues: Array<{ field: string; message: string }> = []
    // A cadeia global: só provedor que existe (o agente ainda filtra pelo que oferece, na hora da troca).
    for (const step of body.fallback?.chain ?? [])
      if (this.usecases.providers && !this.usecases.providers.get(step.provider)) issues.push({ field: 'fallback', message: `unknown provider: ${step.provider}` })
    const current = await this.usecases.settings.read()
    const agentId = body.agentId === undefined ? current.agentId : body.agentId || undefined
    const agent = agentId ? this.agents.get(agentId) : this.agents.fallback()
    if (body.agentId && agent && !this.agents.isRunnable(agent))
      issues.push({ field: 'agentId', message: `${agent.id} is not available (${UNAVAILABLE_LABEL[this.unavailableOf(agent, true) ?? 'no_model']})` })
    const provider = body.provider === undefined ? current.provider : body.provider || undefined
    if (body.provider && agent && !agent.providers.some((target) => target.provider === body.provider))
      issues.push({ field: 'provider', message: `${agent.id} does not run on ${body.provider}` })
    if (body.model && agent && !(provider ? offers(agent, provider, body.model) : agent.providers.some((target) => target.models.includes(body.model!))))
      issues.push({ field: 'model', message: `${body.model} is not an enabled model of ${agent.id}${provider ? ` on ${provider}` : ''}` })

    const classifierProvider = body.classifierProvider === undefined ? current.classifierProvider : body.classifierProvider || undefined
    const classifierModel = body.classifierModel === undefined ? current.classifierModel : body.classifierModel || undefined
    const classifier = body.classifierProvider ? this.usecases.providers?.connection(body.classifierProvider) : undefined
    if (body.classifierProvider && !classifier) issues.push({ field: 'classifierProvider', message: `${body.classifierProvider} is disabled or does not exist` })
    // O classificador fala o SDK plano com chave de API: assinatura não serve, e sem chave nada classifica.
    else if (classifier && isSubscription(classifier.protocol))
      issues.push({ field: 'classifierProvider', message: `${classifier.providerId} is a subscription: the classifier needs an API key` })
    else if (classifier && !classifier.key) issues.push({ field: 'classifierProvider', message: `${classifier.providerId} has no API key` })
    if (
      (body.classifierModel || body.classifierProvider) &&
      classifierProvider &&
      classifierModel &&
      this.usecases.models &&
      !this.usecases.models.isEnabled(classifierProvider, classifierModel)
    ) {
      issues.push({ field: 'classifierModel', message: `${classifierModel} is not enabled in ${classifierProvider}` })
    }

    // O construtor: os dois juntos, provider ligado e modelo ativado nele (ou nenhum dos dois = o do Atlas).
    const builderProvider = body.builderProvider === undefined ? current.builderProvider : body.builderProvider || undefined
    const builderModel = body.builderModel === undefined ? current.builderModel : body.builderModel || undefined
    if (body.builderProvider !== undefined || body.builderModel !== undefined) {
      if (!!builderProvider !== !!builderModel) issues.push({ field: 'builderModel', message: 'choose the provider and the model together (or neither: the ones of Atlas)' })
      else if (builderProvider && builderModel) {
        if (this.usecases.providers && !this.usecases.providers.get(builderProvider)?.enabled)
          issues.push({ field: 'builderProvider', message: `${builderProvider} is disabled or does not exist` })
        else if (this.usecases.models && !this.usecases.models.isEnabled(builderProvider, builderModel))
          issues.push({ field: 'builderModel', message: `${builderModel} is not enabled in ${builderProvider}` })
      }
    }
    return issues
  }

  /**
   * O projeto da conversa — ⛔ escrito SÓ pelo servidor. Agente de projeto: o dele, e quem não pode usar o
   * projeto recebe 404 como de agente inexistente. Agente global: o do corpo (o seletor da tela), se a
   * pessoa puder usá-lo.
   */
  private async sessionProject(caller: IProjectCaller, agentId: string | undefined, requested: string | undefined): Promise<string | undefined> {
    if (!this.usecases.projects) return undefined
    const configured = agentId || (await this.usecases.settings.read()).agentId
    const agent = configured ? this.agents.get(configured) : this.agents.fallback()
    if (agent?.projectId) {
      if (!this.usecases.projects.canUse(caller, agent.projectId)) throw new AgentNotFoundError(agent.id)
      return agent.projectId
    }
    if (!requested) return undefined
    this.requireProject(caller, requested)
    return requested
  }

  /**
   * ⛔ O repositório e a worktree da conversa, conferidos no servidor: só numa conversa de projeto, com a permissão
   * `repository` do agente, e a pasta resolvida dentro do projeto (ver `Work.Folder`). Ausentes = a pasta de sempre.
   */
  private async workPlace(agentId: string | undefined, project: string | undefined, repository?: string, worktree?: string): Promise<IWorkFolder | undefined> {
    if (!repository && !worktree) return undefined
    const invalid = (field: string, message: string) => new HttpError(422, 'validation_error', 'Request body is invalid', [{ field, message }])
    if (!project || !this.usecases.projects) throw invalid('repository', 'only in a project conversation')
    const configured = agentId || (await this.usecases.settings.read()).agentId || this.agents.fallback()?.id
    if (repository && configured && this.usecases.repositoryAllowed && !this.usecases.repositoryAllowed(configured, project, repository))
      throw invalid('repository', `the agent has no permission for repository ${repository}`)
    try {
      return resolveWorkFolder(this.usecases.projects.folderOf(project), repository, worktree)
    } catch (error: unknown) {
      if (error instanceof WorkFolderError) throw invalid(error.message.split(':')[0], error.message)
      throw error
    }
  }

  /** Onde a conversa trabalha, para a tela: o repositório, a worktree e o branch de agora. Pasta que sumiu: sem branch. */
  private placeOf(metadata: Record<string, unknown> | undefined): { repository: string; worktree?: string; branch?: string } | undefined {
    const repository = metadata?.[REPOSITORY_METADATA_KEY]
    const projectId = metadata?.[PROJECT_METADATA_KEY]
    if (typeof repository !== 'string' || typeof projectId !== 'string' || !this.usecases.projects?.exists(projectId)) return undefined
    const worktree = typeof metadata?.[WORKTREE_METADATA_KEY] === 'string' ? (metadata[WORKTREE_METADATA_KEY] as string) : undefined
    try {
      const branch = currentBranch(resolveWorkFolder(this.usecases.projects.folderOf(projectId), repository, worktree).dir)
      return { repository, ...(worktree ? { worktree } : {}), ...(branch ? { branch } : {}) }
    } catch {
      return { repository, ...(worktree ? { worktree } : {}) }
    }
  }

  /** O agente aparece para esta pessoa (neste projeto, se pedido)? O global aparece em todos. */
  private agentVisible(agent: IAgent, caller: IProjectCaller, project?: string): boolean {
    if (!agent.projectId) return true
    if (project) return agent.projectId === project
    return !this.usecases.projects || this.usecases.projects.canUse(caller, agent.projectId)
  }

  /** ⛔ Projeto que a pessoa não pode usar responde como inexistente (404): a lista diz que projetos existem. */
  private requireProject(caller: IProjectCaller, projectId: string): void {
    if (this.usecases.projects && !this.usecases.projects.canUse(caller, projectId)) throw new HttpError(404, 'not_found', `Project not found: ${projectId}`)
  }

  /** O projeto do agente existe e as delegações dele ficam no mesmo projeto (ou vão a um global). */
  private projectIssues(agent: IAgent): Array<{ field: string; message: string }> {
    const issues: Array<{ field: string; message: string }> = []
    if (agent.projectId && this.usecases.projects && !this.usecases.projects.exists(agent.projectId))
      issues.push({ field: 'projectId', message: `no such project: ${agent.projectId}` })
    // ⛔ No projeto, nada de sandbox `full`: o Codex e o Antigravity rodariam soltos, fora da pasta do projeto.
    if (agent.projectId)
      for (const target of agent.providers.filter((candidate) => candidate.sandbox === 'full'))
        issues.push({ field: 'providers', message: `${target.provider}: a project agent cannot use the full sandbox (it would run outside the project folder)` })
    for (const entry of agent.allowedTools.filter((tool) => tool.startsWith('agent:'))) {
      const target = this.agents.get(entry.slice('agent:'.length))
      if (target?.projectId && target.projectId !== agent.projectId) issues.push({ field: 'allowedTools', message: `${entry} is in another project (${target.projectId})` })
    }
    return issues
  }

  /** Por que o agente não abre conversa para este chamador agora (ver `agentUnavailable`). */
  private unavailableOf(agent: IAgent, admin: boolean): TAgentUnavailable | undefined {
    if (!this.usecases.providers) return agent.providers.some((target) => target.models.length) ? undefined : 'no_model'
    return agentUnavailable(agent, (providerId) => this.availabilityFacts(providerId, admin))
  }

  /** Por que ESTE provider do agente não roda para este chamador agora. */
  private targetUnavailableOf(agent: IAgent, target: IAgentTarget, admin: boolean): TAgentUnavailable | undefined {
    if (!this.usecases.providers) return target.models.length ? undefined : 'no_model'
    return targetUnavailable(agent, target, this.availabilityFacts(target.provider, admin))
  }

  private availabilityFacts(providerId: string, admin: boolean): IAvailabilityFacts {
    const directory = this.usecases.providers
    return { provider: directory?.get(providerId), hasKey: !!directory?.connection(providerId)?.key, admin }
  }

  /**
   * O agente na listagem. O admin vê todos os providers, cada inativo com o motivo; quem não administra
   * só vê os que rodam para ele.
   */
  private listedAgent(agent: IAgent, admin: boolean) {
    const unavailable = new Map(agent.providers.map((target) => [target.provider, this.targetUnavailableOf(agent, target, admin)]))
    const visible = admin ? agent : { ...agent, providers: agent.providers.filter((target) => !unavailable.get(target.provider)) }
    return toAgentDto(visible, (providerId) => {
      const reason = unavailable.get(providerId)
      return { ...this.providerFacts(providerId), ...(reason ? { unavailable: { reason, label: UNAVAILABLE_LABEL[reason] } } : {}) }
    })
  }

  /** Nome e protocolo do banco (não um rótulo fixo no código), preços e raciocínio do catálogo. */
  private providerFacts(providerId: string, disabled: Record<string, string[]> = {}): IAgentProviderFacts {
    const models = this.usecases.models
    const provider = this.usecases.providers?.get(providerId)
    return {
      name: provider?.name ?? providerId,
      protocol: provider?.protocol ?? Object.values(EProvider).find((value) => value === providerId),
      pricing: this.pricingOf(providerId),
      reasoningOf: models ? (model) => models.reasoningOf(providerId, model) : undefined,
      contextOf: models ? (model) => models.contextOf(providerId, model) : undefined,
      disabledModels: disabled[providerId],
    }
  }

  /**
   * O agente inteiro, com o prompt — a tela de edição.
   *
   * ⛔ SÓ ADMINISTRADOR, e 404 para os demais (como `/settings`): o prompt é o produto, e a listagem
   * pública existe justamente para não entregá-lo.
   */
  async getAgent(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('getAgent')
      const entry = this.agents.entry(req.params.agentId as string)
      if (!entry) throw new AgentNotFoundError(req.params.agentId as string)

      const disabled = this.agents.unusableModels(entry.agent)
      return toAgentDetailDto(entry, (providerId) => this.providerFacts(providerId, disabled))
    })
  }

  /**
   * O TAMANHO do agente (`?project=` para um global): o que ele carrega antes da primeira mensagem, parte a parte.
   * As ferramentas do MCP `caller` (o do gateway) são pedidas com a credencial de quem está na tela.
   */
  /**
   * Os `/commands` e as skills que a pessoa pode usar com este agente — o autocompletar da caixa de mensagem. ⚖️ De
   * quem pode conversar com o agente, não só admin: só o nome, o tipo e a descrição, nunca o texto.
   */
  async getAgentCommands(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()
      const admin = (await checkAdminAccess(this.usecases.proof)).allowed
      const agent = this.agents.get(req.params.agentId as string)
      if (!agent || !this.agentVisible(agent, { userId: resolved.identity?.id, admin })) throw new AgentNotFoundError(req.params.agentId as string)
      // Os commands e as skills: a caixa sugere os dois ao digitar `/` (a skill escolhida vai inteira, já carregada).
      const guidance = this.usecases.guidance
      const resources = [...(guidance?.usableResources('command', agent.id) ?? []), ...(guidance?.usableResources('skill', agent.id) ?? [])].map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        description: resource.description,
      }))
      // E os documentos da conversa (os globais e os do projeto dela, como o índice do prompt): `/spec:<id>` o anexa inteiro.
      // ⚖️ Título e resumo só — o mesmo que o agente já vê no índice. O projeto vem da tela, e só vale o que a pessoa usa.
      const requested = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      const project =
        agent.projectId ??
        (requested && this.usecases.projects?.exists(requested) && this.usecases.projects.canUse({ userId: resolved.identity?.id, admin }, requested) ? requested : undefined)
      const docs = guidance ? [...guidance.docs(null), ...(project ? guidance.docs(project) : [])] : []
      return [...resources, ...docs.map((doc) => ({ id: `${doc.kind}:${doc.id}`, kind: doc.kind, description: doc.summary ? `${doc.title} — ${doc.summary}` : doc.title }))]
    })
  }

  async getAgentFootprint(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('getAgentFootprint')
      const entry = this.agents.entry(req.params.agentId as string)
      if (!entry) throw new AgentNotFoundError(req.params.agentId as string)
      const requested = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      const projectId = entry.agent.projectId ?? (requested && this.usecases.projects?.exists(requested) ? requested : undefined)
      const token = currentCaller()?.token
      const catalog = this.usecases.catalog
      return agentFootprint(entry.agent, projectId, {
        guidance: this.usecases.guidance,
        localFor: (allowed) => catalog.localFor(allowed),
        projectName: (id) => (this.usecases.projects?.exists(id) ? this.usecases.projects.get(id).name : undefined),
        projectDir: (id) => projectWorkspacePath(id),
        // ⛔ O servidor do escopo do AGENTE (não o do projeto pedido na tela): global só vê global.
        mcpTools: async (server) => {
          const config = catalog.mcp.resolve(server, entry.agent.projectId)
          const tools = config ? await catalog.mcp.probeTools(mcpServerKey(config), token).catch(() => []) : []
          return tools.length ? tools : undefined
        },
      })
    })
  }

  /**
   * Cria um agente. ⛔ Só administrador: dar uma tool a um agente é dar a tool a quem conversa com ele.
   * O que vale como tool, modelo e id é regra do domínio (`agentIssues`) — todos os problemas voltam
   * juntos, em `details`, campo a campo.
   */
  async createAgent(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('createAgent')
        const body = parseBody(agentBodySchema, req.body)
        const input = toAgentInput(body.id ?? '', body)
        const issues = this.projectIssues(input)
        if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)

        const saved = this.agents.save(input, { rules: await this.agentRules(), by: admin.email ?? admin.id ?? 'admin', creating: true })

        return toAgentDetailDto({ agent: saved, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, (providerId) => this.providerFacts(providerId))
      },
      { status: 201, message: 'Agent created' },
    )
  }

  /**
   * Os problemas de um registro de agente, SEM gravar — as mesmas regras de `createAgent`/`updateAgent` (o corpo, o
   * projeto, as ferramentas, os modelos ativados, a delegação). É o que o construtor usa para conferir o rascunho.
   * ⚖️ Id que já existe é ajuste (`exists`): vale a regra da atualização, não a do id livre.
   */
  async agentDraftIssues(body: Record<string, unknown>): Promise<{ issues: Array<{ field: string; message: string }>; exists: boolean }> {
    let parsed: TAgentBody
    try {
      parsed = parseBody(agentBodySchema, body)
    } catch (error: unknown) {
      const details = error instanceof HttpError && Array.isArray(error.details) ? (error.details as Array<{ field: string; message: string }>) : undefined
      return { issues: details ?? [{ field: 'agent', message: error instanceof Error ? error.message : String(error) }], exists: false }
    }
    const id = parsed.id ?? ''
    const exists = !!this.agents.entry(id)
    const raw = toAgentInput(id, parsed)
    const input = { ...raw, allowedTools: toCapabilities(raw.allowedTools) }
    const takenIds = exists ? [] : [...this.agents.list().map((agent) => agent.id), ...CORE_AGENT_IDS]
    return { issues: [...this.projectIssues(input), ...agentIssues(input, { ...(await this.agentRules()), takenIds })], exists }
  }

  /** Substitui um agente. */
  async updateAgent(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateAgent')
        const body = parseBody(agentBodySchema, req.body)
        const parsed = toAgentInput(req.params.agentId as string, body)
        // ⚖️ Quem edita sem mandar as permissões (o MCP, um script) não as apaga: ficam as que o agente já tem.
        const current = body.permissions === undefined ? this.agents.get(parsed.id)?.permissions : undefined
        // O mesmo para o terminal: ausente mantém; `null` volta ao global.
        const terminal = body.terminal === undefined ? this.agents.get(parsed.id)?.terminal : undefined
        const fallback = body.fallback === undefined ? this.agents.get(parsed.id)?.fallback : undefined
        const diagnostics = body.diagnostics === undefined ? this.agents.get(parsed.id)?.diagnostics : undefined
        const triggers = body.triggers === undefined ? this.agents.get(parsed.id)?.triggers : undefined
        const env = body.env === undefined ? this.agents.get(parsed.id)?.env : undefined
        const input = {
          ...parsed,
          ...(current ? { permissions: current } : {}),
          ...(terminal ? { terminal } : {}),
          ...(fallback ? { fallback } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...(triggers?.length ? { triggers } : {}),
          ...(env && Object.keys(env).length ? { env } : {}),
        }
        const issues = this.projectIssues(input)
        if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)

        const saved = this.agents.save(input, {
          rules: await this.agentRules(),
          by: admin.email ?? admin.id ?? 'admin',
          creating: false,
        })

        return toAgentDetailDto({ agent: saved, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, (providerId) => this.providerFacts(providerId))
      },
      { message: 'Agent updated' },
    )
  }

  /**
   * Apaga um agente criado. ⚠️ As conversas gravadas com ele ficam (o histórico é de quem conversou),
   * e uma sessão viva termina com o agente com que nasceu; só não nasce sessão nova.
   */
  async deleteAgent(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('deleteAgent')
        this.agents.remove(req.params.agentId as string, { defaultAgentId: (await this.usecases.settings.read()).agentId })
        this.usecases.agentRemoved?.(req.params.agentId as string)

        return null
      },
      { message: 'Agent deleted' },
    )
  }

  /**
   * Os fatos que a regra do agente precisa, lidos AGORA: as tools do catálogo neste instante (o MCP
   * pode ter subido ou caído) e o que cada provider recusa no prompt. O modelo é conferido no
   * catálogo do provider (`modelEnabled`), nunca pelo prefixo do id.
   */
  private async agentRules(): Promise<Omit<IAgentRules, 'takenIds'>> {
    const tools = await this.usecases.catalog.list(this.localTools)

    return {
      knownTools: tools.map((tool) => tool.name),
      // ⛔ Servidor DESLIGADO não serve: o agente o perdia em silêncio na hora de rodar. E só o do escopo do agente:
      // o global ou o do projeto dele — nunca o de outro projeto.
      mcpServerExists: (id, projectId) => this.usecases.catalog.mcp.resolve(id, projectId)?.enabled === true,
      // ⛔ Delegar só para quem pode abrir conversa agora; um alvo inativo devolvia erro ao modelo-pai.
      agentExists: (id) => {
        const target = this.agents.get(id)
        return !!target && this.agents.isRunnable(target)
      },
      modelEnabled: this.usecases.models ? (provider, model) => this.usecases.models!.isEnabled(provider, model) : undefined,
      protocolOf: (id) => this.usecases.providers?.get(id)?.protocol ?? Object.values(EProvider).find((value) => value === id),
      promptIssue: (agent) => {
        const protocols = agent.providers.map((target) => this.usecases.providers?.get(target.provider)?.protocol ?? target.provider)
        if (!protocols.includes(EProvider.GOOGLE)) return undefined
        try {
          // O soul vai junto no prompt: as mesmas `{chaves}` quebrariam o ADK nele também.
          assertNoAdkTemplateCollision(`${agent.soul ?? ''}\n${agent.systemPrompt}`)
          return undefined
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    }
  }

  async getAgentTools(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()
      const admin = (await checkAdminAccess(this.usecases.proof)).allowed
      const agentId = req.params.agentId as string
      const agent = this.agents.get(agentId)
      // ⛔ O agente de um projeto (e os MCPs dele) não existe para quem não é do projeto.
      if (!agent || !this.agentVisible(agent, { userId: resolved.identity?.id, admin })) throw new AgentNotFoundError(agentId)

      // As capacidades entram pelas ferramentas do gateway que as implementam (a lista é a mesma em todo provedor).
      // ⛔ Os MCPs: só os do escopo do agente (os globais e os do projeto dele).
      return this.catalogFor([...agent.allowedTools, ...agent.allowedTools.flatMap((tool) => capability(tool)?.local ?? [])], (server) => mcpServesProject(server, agent.projectId))
    })
  }

  async getTools(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()
      const caller = { userId: resolved.identity?.id, admin: (await checkAdminAccess(this.usecases.proof)).allowed }
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined
      if (project) this.requireProject(caller, project)
      // ⛔ MCP de projeto só para quem é do projeto: com `?project`, os globais e os dele; sem, os dos projetos da pessoa.
      const serves = (server: { projectId?: string }) =>
        !server.projectId || (project ? server.projectId === project : !this.usecases.projects || this.usecases.projects.canUse(caller, server.projectId))
      // As nativas vão junto, todas liberadas. `dangerous`: alcança este servidor — a tela avisa quem configura.
      const dangerous = (id: string) => dangerousToolsOf([id]).length > 0
      // ⚖️ O que virou CAPACIDADE (Terminal, Arquivos, Busca…) não aparece solto: vem em `capabilities`, com o que roda em
      // cada provedor. Ficam as nativas que só um provedor tem (os "extras") e as locais que não são capacidade.
      const native = NATIVE_TOOLS.filter((tool) => !CAPABILITY_TOOLS.has(tool.id)).map((tool) => ({ ...tool, dangerous: dangerous(tool.id) }))
      const catalog = await this.catalogFor(this.localTools, serves)
      // As que o servidor oferece de fato (o perímetro `LOCAL_TOOLS_ENABLED` já aplicado).
      const perimeter = catalog.tools.filter((tool) => tool.origin === 'local').map((tool) => tool.name)
      const capabilities = CAPABILITIES.filter((item) => !item.local.length || item.local.some((tool) => perimeter.includes(tool))).map((item) => ({
        id: `${CAPABILITY_PREFIX}${item.id}`,
        label: item.label,
        description: item.description,
        risk: item.risk,
        dangerous: item.risk.startsWith('server-'),
        runs: Object.fromEntries(Object.values(EProvider).map((protocol) => [protocol, capabilityRuns(item, protocol)])),
      }))
      return {
        ...catalog,
        tools: catalog.tools.filter((tool) => !CAPABILITY_TOOLS.has(tool.name)).map((tool) => ({ ...tool, dangerous: dangerous(tool.name) })),
        capabilities,
        native,
        limits: { delegationMaxDepth: delegationMaxDepth() },
      }
    })
  }

  async createSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const resolved = await this.requireCaller()

        // ⛔ A AUDIÊNCIA vem ANTES do corpo: quem é recusado não precisa saber se o corpo estava
        // certo, e uma sessão não nasce para quem o agente não atende.
        if (!(await this.admits(resolved))) throw new AgentUnavailableError()

        const body = parseBody(createSessionSchema, req.body)
        // O papel PROVADO de administrador: libera assinatura, ferramenta perigosa e o que segue abaixo.
        const adminAccess = (await checkAdminAccess(this.usecases.proof)).allowed

        // ⛔ Trocar as instruções do agente é decisão de quem o administra: um membro descartaria as
        // regras que o admin escreveu (as travas do agente vivem no prompt).
        if (body.systemPrompt?.trim() && !adminAccess) {
          throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'systemPrompt', message: 'only administrators can replace the agent instructions' }])
        }

        // ⛔ O `owner` (e a delegação) do corpo são descartados SEMPRE: só o servidor os escreve. Para
        // quem não é admin, também as chaves que abrem a rede de um contêiner (`{meta:…}`).
        // ⛔ O construtor é do core e só de admin: para quem não é, ele nem existe (o `adminOnly` do provider é a segunda trava).
        if (builderKindOf(body.agentId) && !adminAccess) throw new AgentNotFoundError(body.agentId!)

        const { metadata, issues } = clientMetadata(body.metadata, { admin: adminAccess, protectedKeys: this.egressMetadataKeys() })
        if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)
        const owner = ownerOf(resolved)

        // ⛔ Teto por dono: sem ele, 500 sessões de uma pessoa despejavam as de todo mundo.
        const mine = (await this.usecases.listSessions.execute()).filter((session) => (session.metadata?.owner as { id?: string } | undefined)?.id === owner?.id).length
        if (mine >= sessionsPerOwner()) throw new HttpError(429, 'rate_limited', `At most ${sessionsPerOwner()} live conversations per account: close one first`)

        const { projectId: requested, repository, worktree, callbackUrl, ...session } = body
        const project = await this.sessionProject({ userId: resolved.identity?.id, admin: adminAccess }, body.agentId, requested)
        const place = await this.workPlace(body.agentId, project, repository, worktree)
        const startCommit = place ? await headOf(place.dir) : undefined
        if (callbackUrl && !this.usecases.callbackAllowed?.(callbackUrl))
          throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'callbackUrl', message: 'host not in TURN_CALLBACK_HOSTS' }])
        // ⛔ A marca de construção também é só do servidor: vem do agente, nunca do corpo (esconderia a conversa da caixa).
        const { [BUILDER_METADATA_KEY]: _builder, ...declared } = metadata ?? {}
        const building = builderKindOf(body.agentId)
        const stamped = {
          ...declared,
          ...(owner ? { owner } : {}),
          ...(project ? { [PROJECT_METADATA_KEY]: project } : {}),
          ...(building ? { [BUILDER_METADATA_KEY]: building } : {}),
          ...(place?.repository ? { [REPOSITORY_METADATA_KEY]: place.repository } : {}),
          ...(place?.worktree ? { [WORKTREE_METADATA_KEY]: place.worktree } : {}),
          ...(startCommit ? { [START_COMMIT_METADATA_KEY]: startCommit } : {}),
          ...(callbackUrl ? { [CALLBACK_METADATA_KEY]: callbackUrl } : {}),
        }
        return this.usecases.createSession.execute({ ...session, metadata: stamped, adminAccess })
      },
      { status: 201, message: 'Session created successfully' },
    )
  }

  /**
   * O agente atende ESTE chamador agora?
   *
   * ⚖️ ABERTA A QUALQUER CHAMADOR AUTENTICADO, ao contrário das rotas de administração: é o que a
   * tela consulta para decidir se mostra o botão do assistente, e quem a consulta não é
   * administrador.
   *
   * ⛔ Só devolve SIM ou NÃO. Qual modelo está em uso e para quem o agente está aberto continuam
   * sendo assunto de quem opera. Credencial que não passa na prova responde NÃO, em vez de 401: é a
   * mesma resposta que a porta de `POST /sessions` daria, só que sem barulho para a tela.
   */
  async availability(_req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await resolveCaller(this.usecases.proof)

      return { available: resolved ? await this.admits(resolved) : false }
    })
  }

  /**
   * As configurações de operação — leitura.
   *
   * ⛔ SÓ ADMINISTRADOR (`checkAdminAccess`), e quem não é recebe 404, não 403: a existência da rota
   * é informação, e quem lê sabe qual modelo está em uso e para quem o agente está aberto.
   */
  async getSettings(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('getSettings')

      /**
       * Junto do que está GRAVADO vai o que VALE quando o campo está vazio.
       *
       * ⚖️ Sem isso a tela mostra selects em branco e não há como saber o que está rodando — "não
       * configurado" e "não sei" ficam iguais, e a pessoa configura no escuro.
       */
      const fallback = this.agents.fallback()

      const bash = bashPolicy()
      const loop = loopLimits()

      return {
        ...(await this.usecases.settings.read()),
        defaults: { agentId: fallback?.id, ...(fallback ? targetFor(fallback, undefined, undefined, (target) => this.agents.isTargetRunnable(fallback, target)) : {}) },
        // O que vale AGORA (a tela, senão o `.env`, senão o padrão) e a faixa que a gravação aceita.
        limitsInEffect: {
          maxToolTurns: maxToolTurns(),
          maxOutputTokens: maxOutputTokens(),
          delegationMaxDepth: delegationMaxDepth(),
          bashTimeoutMs: bash.timeoutMs,
          bashMaxOutputChars: bash.maxOutputChars,
          sessionsPerOwner: sessionsPerOwner(),
          streamsPerOwner: streamsPerOwner(),
          compactAtPercent: compactAtPercent(),
          loopRefuseAt: loop.refuseAt,
          loopStopAt: loop.stopAt,
          loopMaxErrors: loop.maxErrors,
        },
        limitBounds: LIMIT_BOUNDS,
        // Os provedores sem cota agora (ver `Provider.Bench`) e quando voltam.
        benched: this.usecases.bench?.list() ?? [],
        // ⛔ Decisões de implantação e de segurança: a tela MOSTRA, e só o deploy muda.
        deployment: {
          localToolsEnabled: process.env.LOCAL_TOOLS_ENABLED?.trim() || undefined,
          allowAnonymous: process.env.ALLOW_ANONYMOUS === '1',
          // O cerco dos agentes de projeto funciona AQUI? Sem ele, o Bash deles fica bloqueado.
          ...(this.usecases.sandbox ? { sandbox: await this.usecases.sandbox.status() } : {}),
          // Sem Docker, o MCP em contêiner não sobe: a tela desliga a opção e avisa nos que existem.
          ...(this.usecases.docker ? { docker: await this.usecases.docker() } : {}),
        },
      }
    })
  }

  /** Escrita parcial. Mesma porta da leitura: quem escreve desliga o agente para todo mundo. */
  async updateSettings(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateSettings')
        const body = parseBody(updateSettingsSchema, req.body)

        // ⚠️ Agente que não existe aqui faria TODA sessão nova falhar com `agent_not_found` — e a
        // tela teria dito "salvo". Recusa na gravação, onde a causa ainda está à vista.
        if (typeof body.agentId === 'string' && body.agentId && !this.agents.get(body.agentId)) {
          throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'agentId', message: `unknown agent: ${body.agentId}` }])
        }
        // O construtor é do core: abre só pela tela de construção, nunca como o padrão.
        if (typeof body.agentId === 'string' && CORE_AGENT_IDS.includes(body.agentId)) {
          throw new HttpError(422, 'validation_error', 'Request body is invalid', [
            { field: 'agentId', message: `${body.agentId} is a core agent: it cannot be the default agent` },
          ])
        }
        // Subagente como padrão faria toda conversa sem agente escolhido falhar com `subagent_only`.
        if (typeof body.agentId === 'string' && body.agentId && this.agents.get(body.agentId)?.role === 'subagent') {
          throw new HttpError(422, 'validation_error', 'Request body is invalid', [{ field: 'agentId', message: `${body.agentId} is a subagent: it cannot be the default agent` }])
        }
        // ⛔ Nada que não esteja ATIVO: antes o modelo inválido era trocado em silêncio pelo primeiro do agente.
        const issues = await this.settingsIssues(body)
        if (issues.length) throw new HttpError(422, 'validation_error', 'Request body is invalid', issues)

        // Merge, não substituição: a tela manda o que mudou. O repositório SUBSTITUI o documento.
        const current = await this.usecases.settings.read()
        await this.usecases.settings.save(mergeSettings(current, body, admin.email ?? admin.id))

        return this.usecases.settings.read()
      },
      { message: 'Settings updated' },
    )
  }

  /**
   * As conversas GRAVADAS (as que sobrevivem ao processo), em oposição a `GET /sessions`, que lista as
   * VIVAS. Uma sessão viva pode não ter turno ainda; uma conversa gravada quase sempre não tem sessão
   * viva (o processo reiniciou, o TTL expirou). A tela de histórico quer esta.
   *
   * ⛔ O RECORTE POR DONO NÃO VEM DA QUERY. Vem da credencial provada, e qualquer `owner*` na query é
   * descartado — `?owner=<outro>` seria todo o trabalho necessário para ler a conversa alheia. O resto
   * da query vira filtro sobre `metadata`: são rótulos, não identidade.
   *
   * `?scope=all` é o monitor: caminho SEPARADO e explícito, só para administrador. Deixá-lo como
   * ausência de filtro faria a rota irrestrita ser a fácil de alcançar por engano.
   */
  async listConversations(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const query = req.query as Record<string, unknown>
        if (query.scope === 'all') return this.listAllConversations(query)

        const resolved = await this.requireCaller()
        const identity = resolved.identity
        // `?project=` filtra pela chave `project` do metadata (escrita só pelo servidor); quem não pode usar o projeto, 404.
        if (typeof query.project === 'string' && query.project)
          this.requireProject({ userId: identity?.id, admin: (await checkAdminAccess(this.usecases.proof)).allowed }, query.project)

        const limit = Number.parseInt(String(query.limit ?? ''), 10)
        const sessions = await this.usecases.conversations.listSessions({
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          filter: metadataFilter(query),
          // Sem identidade (anônimo) = só as SEM dono; com identidade = só as dela.
          owner: identity?.id ? { id: identity.id, account: identity.account } : null,
        })

        // Cinto e suspensório: o SQL já recortou, e a mesma regra do resto da API confere de novo.
        const view = this.viewFor(false)

        return { sessions: sessions.filter((session) => ownsSession(resolved, session.metadata)).map((session) => toConversationDto(session, view)) }
      },
      { message: 'Conversations listed' },
    )
  }

  /**
   * TODAS as conversas, de todo mundo — o monitor.
   *
   * ⛔ É A EXCEÇÃO AO ISOLAMENTO desta API, e a única junto de `stats`: administrador PROVADO
   * (`checkAdminAccess`) ou 404, sem distinguir os motivos. Com `page`, a paginação é no servidor.
   */
  private async listAllConversations(query: Record<string, unknown>) {
    await this.requireAdmin('listAllConversations')
    const view = this.viewFor(true)

    if (query.page !== undefined) {
      const paging = parsePageQuery(query)
      const page = await this.usecases.conversations.pageSessions(paging)

      return { ...page, sessions: page.sessions.map((session) => toConversationDto(session, view)), page: paging.page, pageSize: paging.pageSize, scope: 'all' }
    }

    const limit = Number.parseInt(String(query.limit ?? ''), 10)
    const sessions = await this.usecases.conversations.listSessions({
      limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
      filter: metadataFilter(query, ['page', 'pageSize', 'q', 'classification', 'provider', 'agentId']),
    })

    return { sessions: sessions.map((session) => toConversationDto(session, view)), scope: 'all' }
  }

  /**
   * As mudanças nas conversas gravadas, ao vivo (SSE) — o que mantém a caixa de entrada em dia.
   *
   * ⛔ A MESMA REGRA DA LISTAGEM, aplicada evento a evento: administrador vê todas; os demais, só as
   * suas (`ownsSession`). O veredito é tomado ao conectar — quem perde o papel de admin continua
   * recebendo até reconectar, como continuaria com a lista já aberta na tela.
   *
   * ⚠️ `conversation.updated` sai na projeção de quem LÊ (`toConversationDto`): o não administrador
   * não recebe rótulo nem custo por aqui, do mesmo jeito que não recebe pela listagem.
   */
  async conversationEvents(req: Request, res: Response) {
    let resolved: IResolvedCaller
    let admin: boolean
    const requested = (req.query as Record<string, unknown> | undefined)?.project
    const project = typeof requested === 'string' && requested ? requested : undefined
    try {
      resolved = await this.requireCaller()
      admin = (await checkAdminAccess(this.usecases.proof)).allowed
      if (project) this.requireProject({ userId: resolved.identity?.id, admin }, project)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.conversationEvents]')
    }

    const key = ownerOf(resolved)?.id ?? ''
    if (!this.holdStream(key)) return this.sendFailure(res, new HttpError(429, 'rate_limited', 'Too many open event streams'), '[AgentController.conversationEvents]')

    const stream = new SseStream(res)
    stream.open()
    // O id deste stream: é por ele que a tela pede o turno ao vivo da conversa aberta (`followTurn`), sem outra conexão.
    const streamId = randomUUID()
    const inbox: { owner: string; emit: (type: string, data: object) => void; unfollow?: () => void } = { owner: key, emit: (type, data) => stream.emit(type, data) }
    this.inboxStreams.set(streamId, inbox)
    stream.emit('stream.ready', { streamId })

    const view = this.viewFor(admin)
    const visible = (metadata: Record<string, unknown> | undefined) =>
      (admin || ownsSession(resolved, metadata)) &&
      // Com `?project`, só as conversas daquele projeto.
      (!project || metadata?.[PROJECT_METADATA_KEY] === project) &&
      // As construções não entram na caixa de entrada (a guia Construir as lista).
      !metadata?.[BUILDER_METADATA_KEY]
    const unsubscribe =
      this.usecases.events?.subscribe((event: TConversationEvent) => {
        if (!visible(event.type === 'conversation.updated' ? event.session.metadata : event.metadata)) return
        if (event.type === 'conversation.updated') stream.emit(event.type, { session: toConversationDto(event.session, view) })
        else stream.emit(event.type, { sessionId: event.sessionId })
      }) ?? (() => undefined)
    // Quem conecta (ou reconecta) fica sabendo das que JÁ estão rodando.
    for (const running of this.usecases.live?.running() ?? []) if (visible(running.metadata)) stream.emit('conversation.running', { sessionId: running.sessionId })

    // Em `res`, não em `req` — ver `sendMessageAsStream`: o `close` do request dispara cedo demais.
    res.on('close', () => {
      unsubscribe()
      inbox.unfollow?.()
      this.inboxStreams.delete(streamId)
      stream.close()
      this.releaseStream(key)
    })
  }

  /**
   * `PUT /conversations/events/:streamId/follow` — o turno ao vivo de UMA conversa, no stream da caixa de entrada já
   * aberto (`{ sessionId }`; `null` para de acompanhar). Os mesmos `turn.*` do `/sessions/:id/live`, com o `sessionId`,
   * e `turn.idle` quando não há turno rodando ao começar a acompanhar.
   *
   * ⚖️ NA MESMA CONEXÃO, e não numa segunda: o navegador abre no máximo seis por host em HTTP/1.1, e duas permanentes
   * por aba travavam todas as chamadas com três abas abertas.
   *
   * ⛔ O stream tem de ser de quem pede, e a conversa, dele (ou admin): 404 nos dois casos.
   */
  async followTurn(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()
      const inbox = this.inboxStreams.get(String(req.params.streamId ?? ''))
      if (!inbox || inbox.owner !== (ownerOf(resolved)?.id ?? '')) throw new HttpError(404, 'not_found', 'Stream not found')
      const { sessionId } = parseBody(followTurnSchema, req.body)
      inbox.unfollow?.()
      inbox.unfollow = undefined
      if (!sessionId) return { following: null }
      await this.requireLiveAccess(sessionId)
      inbox.unfollow = this.watchTurn(sessionId, (type, data) => inbox.emit(type, { sessionId, ...data }), true)
      return { following: sessionId }
    })
  }

  /**
   * `GET /sessions/:id/live` — o turno da conversa AO VIVO (SSE), venha da tela, da API, de um agendamento ou de uma
   * delegação. Ao conectar, o turno em curso (`turn.started`, com o que já saiu); depois cada evento (`turn.event`, já
   * mascarado) e o fim (`turn.finished`, com o turno já gravado). Fica aberta esperando o próximo.
   *
   * ⛔ Dono ou administrador (404 aos demais), e o mesmo teto de streams por conta da caixa de entrada.
   */
  async sessionLive(req: Request, res: Response) {
    const sessionId = req.params.id as string
    let key: string
    try {
      key = ownerOf(await this.requireLiveAccess(sessionId))?.id ?? ''
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sessionLive]')
    }
    if (!this.holdStream(key)) return this.sendFailure(res, new HttpError(429, 'rate_limited', 'Too many open event streams'), '[AgentController.sessionLive]')

    const stream = new SseStream(res)
    stream.open()
    stream.comment('ready')
    const unwatch = this.watchTurn(sessionId, (type, data) => stream.emit(type, data), false)

    res.on('close', () => {
      unwatch()
      stream.close()
      this.releaseStream(key)
    })
  }

  /** Dono da conversa ou admin, ou 404. A sessão viva primeiro: a conversa nova só chega ao banco no fim do primeiro turno. */
  private async requireLiveAccess(sessionId: string): Promise<IResolvedCaller> {
    const resolved = await this.requireCaller()
    const admin = (await checkAdminAccess(this.usecases.proof)).allowed
    let metadata: Record<string, unknown> | undefined
    let found = true
    try {
      metadata = (await this.usecases.getSession.execute(sessionId)).metadata
    } catch {
      const stored = await this.usecases.conversations.findSession(sessionId).catch(() => undefined)
      found = !!stored
      metadata = stored?.metadata
    }
    if (!found || (!admin && !ownsSession(resolved, metadata))) throw new SessionNotFoundError(sessionId)
    return resolved
  }

  /** Assina o turno ao vivo da conversa e manda o que já está rodando. Devolve quem cancela. */
  private watchTurn(sessionId: string, emit: (type: string, data: object) => void, sayIdle: boolean): () => void {
    const live = this.usecases.live
    const unsubscribe =
      live?.subscribe(sessionId, (signal) => {
        if (signal.type === 'turn.started') emit(signal.type, { turn: signal.turn })
        else if (signal.type === 'turn.event') emit(signal.type, { event: signal.event })
        else emit(signal.type, {})
      }) ?? (() => undefined)
    const current = live?.snapshot(sessionId)
    if (current) emit('turn.started', { turn: current })
    // Quem passa a acompanhar no meio de uma reconexão fica sabendo que o turno que via já acabou.
    else if (sayIdle) emit('turn.idle', {})
    return unsubscribe
  }

  /** ⛔ Teto de streams abertos por conta: cada um segura uma inscrição e um relógio de heartbeat. */
  private holdStream(key: string): boolean {
    const open = this.openStreams.get(key) ?? 0
    if (open >= streamsPerOwner()) return false
    this.openStreams.set(key, open + 1)
    return true
  }

  private releaseStream(key: string): void {
    const left = (this.openStreams.get(key) ?? 1) - 1
    if (left > 0) this.openStreams.set(key, left)
    else this.openStreams.delete(key)
  }

  /** As chaves de `metadata` que algum contêiner usa no egresso (`{meta:chave}`). */
  private egressMetadataKeys(): string[] {
    return this.usecases.catalog.mcp.list().flatMap((server) => metaPlaceholderKeys(server.container?.allowedHosts ?? []))
  }

  /**
   * O retrato agregado — totais, por modelo, por sinal e o custo estimado.
   *
   * ⛔ MESMA PORTA DO MONITOR. Não é conteúdo, mas é o retrato de quem usa e quanto custa — e isso
   * não é de qualquer um. Registrada ANTES de `/conversations/:id` para o `stats` nunca ser lido como id.
   */
  async conversationStats(_req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.requireAdmin('conversationStats')

        return toStatsDto(await this.usecases.conversations.stats(), (provider) => this.pricingOf(provider))
      },
      { message: 'Stats computed' },
    )
  }

  /** Os turnos de uma conversa gravada. Dono ou administrador; qualquer outro recebe 404. */
  async getConversationTurns(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        const { conversation, admin } = await this.requireConversationAccess(id)
        const view = this.viewFor(admin)

        const turns = await this.usecases.conversations.listTurns(id)

        // `agentId`: a tela sabe de quem é a conversa mesmo quando ela é de outro projeto que o atual (o autocompletar de `/`).
        return { sessionId: id, agentId: conversation.agentId, turns: turns.map((turn) => toTurnDto(turn, conversation, view)) }
      },
      { message: 'Turns listed' },
    )
  }

  /** A lista de tarefas da conversa (a do `update_todos`). Dono ou administrador; qualquer outro recebe 404. */
  async getConversationTodos(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = req.params.id as string
      await this.requireConversationAccess(id)
      const todos = (await this.usecases.conversations.todos?.(id)) ?? { items: [] }
      return { sessionId: id, items: todos.items, ...(todos.updatedAt ? { updatedAt: todos.updatedAt } : {}) }
    })
  }

  /**
   * Abre ou fecha a conversa por link. Dono ou administrador.
   *
   * ⚠️ O administrador também pode: quem já lê a conversa inteira não ganha poder novo
   * compartilhando-a. O que não pode é um terceiro abrir a conversa de outro por conhecer o id.
   *
   * O `shareId` nasce no primeiro compartilhamento e é REUSADO: religar devolve o mesmo link, e
   * desligar não o apaga — só a leitura pública passa a recusá-lo.
   */
  async shareConversation(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        const { conversation } = await this.requireConversationAccess(id)
        const { shared } = parseBody(shareConversationSchema, req.body)

        const shareId = conversation.shareId ?? newShareId()
        await this.usecases.conversations.setShared(id, shared, shared ? shareId : undefined)

        return { sessionId: id, shared, shareId: shared ? shareId : undefined }
      },
      { message: 'Conversation sharing updated' },
    )
  }

  /**
   * A conversa compartilhada, para quem NÃO tem credencial. A única rota desta API sem dono (ver
   * `PUBLIC_PATHS`).
   *
   * ⛔ SÓ LEITURA, e só a projeção pública — ver `toSharedConversation`. Devolver o turno gravado
   * publicaria retorno cru de ferramenta, raciocínio do modelo, anexos e o rótulo da conversa.
   *
   * ⚠️ NÃO EXISTE e NÃO COMPARTILHADA respondem IGUAL (404): distinguir contaria a quem sondasse quais
   * links existem. O `:id` é o `shareId`; o id da sessão não abre nada por aqui.
   */
  async getSharedConversation(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const conversation = await this.usecases.conversations.findByShareId(req.params.id as string)
        if (!conversation?.shared || !conversation.shareId) throw new HttpError(404, 'not_found', 'Shared conversation not found')

        const turns = await this.usecases.conversations.listTurns(conversation.id)

        return toSharedConversation({ ...conversation, shareId: conversation.shareId }, turns)
      },
      { message: 'Shared conversation' },
    )
  }

  /**
   * Apaga o registro (cabeçalho e turnos). Dono ou administrador.
   *
   * ⚠️ A sessão VIVA, se houver, segue: quem a encerra é `DELETE /sessions/:id`. São coisas distintas.
   */
  async deleteConversation(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireConversationAccess(id)

        await this.usecases.conversations.deleteSession(id)
        return null
      },
      { message: 'Conversation deleted' },
    )
  }

  async listSessions(_req: Request, res: Response) {
    // ⛔ SÓ AS DO PRÓPRIO CHAMADOR. Listar tudo entregaria os ids vivos de todo mundo, e o id é a
    // única coisa que separa uma pessoa de dirigir a sessão de outra.
    await this.respond(res, async () => {
      const resolved = await this.requireCaller()

      return (await this.usecases.listSessions.execute()).filter((session) => ownsSession(resolved, session.metadata)).map(toSessionDto)
    })
  }

  async getSession(req: Request, res: Response) {
    await this.respond(res, async () => {
      const id = req.params.id as string
      await this.requireOwnedSession(id)

      const session = await this.usecases.getSession.execute(id)
      const place = this.placeOf(session.metadata)
      return { ...toSessionDto(session), ...(place ? { place } : {}) }
    })
  }

  async deleteSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireOwnedSession(id)

        await this.usecases.deleteSession.execute(id)
        // Os processos em segundo plano da conversa vão junto.
        this.usecases.sessionEnded?.(id)
        return null
      },
      { message: 'Session deleted successfully' },
    )
  }

  /**
   * Troca o modelo e/ou o raciocínio de uma sessão viva, a partir do próximo turno. Mesma regra de
   * dono das outras rotas da sessão: de outra pessoa é 404.
   */
  async reconfigureSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireOwnedSession(id)
        const body = parseBody(reconfigureSessionSchema, req.body)

        return toSessionDto(this.usecases.reconfigureSession.execute(id, body))
      },
      { message: 'Session updated' },
    )
  }

  /** Compacta o contexto da conversa no início do próximo turno (ver `Compaction.Policy`). Mesma regra de dono. */
  async compactSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireOwnedSession(id)
        return toSessionDto(this.usecases.reconfigureSession.compact(id))
      },
      { message: 'Context compacts at the start of the next turn' },
    )
  }

  async cancelSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        // O cancelamento por aba fechada (`res.on('close')`, abaixo) vai direto ao use case, sem
        // passar por aqui: fechar a própria aba continua funcionando.
        await this.requireOwnedSession(id)

        await this.usecases.cancelSession.execute(id)
        return null
      },
      { message: 'Session cancelled successfully' },
    )
  }

  /**
   * `Accept` decide o formato: `text/event-stream` (default) transmite evento a evento,
   * `application/json` devolve o turno agregado de uma vez — que é o que torna a API
   * utilizável de curl, de script e de teste automatizado.
   */
  async sendMessage(req: Request, res: Response) {
    const sessionId = req.params.id as string

    // ⛔ ANTES de qualquer corpo ou modelo: mandar mensagem GASTA modelo, e numa sessão alheia gasta no
    // nome de outra pessoa. O dono é conferido primeiro, e a resposta é a mesma de sessão inexistente.
    let resolved: IResolvedCaller
    try {
      resolved = await this.requireOwnedSession(sessionId, { resume: true })
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }

    let body
    try {
      body = parseBody(sendMessageSchema, req.body)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }

    let input: IMessageInput
    try {
      input = await this.turnInput(sessionId, resolved, body)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }
    // ⚖️ Com o turno rodando e `whileBusy: 'queue'`, a mensagem espera na fila dele e entra no MESMO turno (ver
    // `Interjection.Policy`). Conversa parada: segue como um turno normal.
    try {
      const position = body.whileBusy === 'queue' ? this.queue(sessionId, body, input) : undefined
      if (position !== undefined) return res.status(202).json(ok({ queued: true, position }, 'Message queued for the running turn'))
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }
    const wantsJson = req.accepts(['text/event-stream', 'application/json']) === 'application/json'

    return wantsJson ? this.sendMessageAsJson(res, sessionId, input) : this.sendMessageAsStream(res, sessionId, input)
  }

  /**
   * A mensagem como o turno a recebe: o contexto da primeira (a identidade) e o `/command` expandido. O projeto, o
   * repositório e o diretório vão no system prompt ("## Ambiente", ver `Ambient.Policy`). ⛔ Command que existe mas não
   * está liberado para este agente é recusado (422).
   */
  private async turnInput(sessionId: string, resolved: IResolvedCaller, body: { message: string; files?: IMessageInput['files'] }): Promise<IMessageInput> {
    // O contexto sai da identidade já resolvida e é aplicado pelo use case, só na primeira mensagem.
    const context = this.usecases.sessionContext?.({ ...resolved.identity }) || undefined
    // `/nome argumentos`: o command liberado ao agente vira o texto dele (com os documentos anexados); o turno grava o
    // que a pessoa digitou.
    const session = await this.usecases.getSession.execute(sessionId)
    const project = session.metadata?.[PROJECT_METADATA_KEY]
    const expanded = this.usecases.guidance?.expandCommand(body.message, session.agentId, typeof project === 'string' ? project : undefined)
    return { text: expanded?.text ?? body.message, files: body.files, context, ...(expanded ? { recordAs: expanded.label } : {}) }
  }

  /** A mensagem na fila do turno rodando: a posição, ou nada (conversa parada). Anexo não entra na fila: segue o 409. */
  private queue(sessionId: string, body: { files?: unknown[] }, input: IMessageInput): number | undefined {
    if (body.files?.length) return undefined
    return this.usecases.sendMessage.enqueue(sessionId, input.text)
  }

  /**
   * `POST /sessions/:id/turns` — ⛔ O TURNO ASSÍNCRONO, para quem orquestra agentes (a esteira): responde 202 na hora e o
   * turno roda no servidor, sem cliente ligado. O estado sai em `GET …/turns/:turn`, e o fim vai para o `callbackUrl` da
   * conversa (POST assinado). Um turno por conversa: o segundo, com o primeiro rodando, é 409.
   */
  async startTurn(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const sessionId = req.params.id as string
        const resolved = await this.requireOwnedSession(sessionId, { resume: true })
        const body = parseBody(sendMessageSchema, req.body)
        const session = await this.usecases.getSession.execute(sessionId)
        const input = await this.turnInput(sessionId, resolved, body)
        const position = body.whileBusy === 'queue' ? this.queue(sessionId, body, input) : undefined
        if (position !== undefined) return { conversationId: sessionId, turn: this.liveTurns.get(sessionId)?.turn ?? session.turns - 1, status: 'queued' as const, position }
        if (session.status === 'running' || this.liveTurns.has(sessionId)) throw new SessionBusyError(sessionId)
        const live: ILiveTurn = { turn: session.turns, startedAt: Date.now(), text: '', tools: [] }
        this.liveTurns.set(sessionId, live)
        const callback = session.metadata?.[CALLBACK_METADATA_KEY]
        void this.runTurn(sessionId, input, live, typeof callback === 'string' ? callback : undefined)
        return { conversationId: sessionId, turn: live.turn, status: 'running' as const }
      },
      { status: 202, message: 'Turn started' },
    )
  }

  /**
   * `GET /sessions/:id/changes` — ⛔ O QUE O AGENTE MUDOU, como nas IDEs: os arquivos e os commits do recorte (`scope`:
   * nesta conversa, não commitado, o branch inteiro) ou de um `commit`; com `file`, o diff daquele arquivo. Só numa
   * conversa aberta num repositório, para o dono dela; git só de leitura (ver `Git.Changes`).
   */
  async changes(req: Request, res: Response) {
    await this.respond(res, async () => {
      const sessionId = req.params.id as string
      await this.requireOwnedSession(sessionId, { resume: true })
      const session = await this.usecases.getSession.execute(sessionId)
      const metadata = session.metadata
      const repository = metadata?.[REPOSITORY_METADATA_KEY]
      const projectId = metadata?.[PROJECT_METADATA_KEY]
      if (typeof repository !== 'string' || typeof projectId !== 'string' || !this.usecases.projects?.exists(projectId))
        throw new HttpError(404, 'not_found', 'Esta conversa não foi aberta num repositório')
      const worktree = typeof metadata?.[WORKTREE_METADATA_KEY] === 'string' ? (metadata[WORKTREE_METADATA_KEY] as string) : undefined
      let dir: string
      try {
        dir = resolveWorkFolder(this.usecases.projects.folderOf(projectId), repository, worktree).dir
      } catch (error: unknown) {
        throw new HttpError(404, 'not_found', error instanceof Error ? error.message : String(error))
      }
      const scope = String(req.query.scope ?? 'conversation') as TChangeScope
      if (!CHANGE_SCOPES.includes(scope)) throw new HttpError(422, 'validation_error', `scope: one of ${CHANGE_SCOPES.join(', ')}`)
      const commit = typeof req.query.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(req.query.commit) ? req.query.commit : undefined
      if (req.query.commit !== undefined && !commit) throw new HttpError(422, 'validation_error', 'commit: a commit sha')
      const startCommit = typeof metadata?.[START_COMMIT_METADATA_KEY] === 'string' ? (metadata[START_COMMIT_METADATA_KEY] as string) : undefined
      let changes
      try {
        changes = await changesOf(dir, scope, { ...(startCommit ? { startCommit } : {}), ...(commit ? { commit } : {}) })
      } catch (error: unknown) {
        throw new HttpError(422, 'validation_error', error instanceof Error ? error.message : String(error))
      }
      const file = typeof req.query.file === 'string' ? req.query.file : undefined
      if (!file) return changes
      try {
        return { file, ...(await fileDiff(dir, changes, file)) }
      } catch (error: unknown) {
        throw new HttpError(404, 'not_found', error instanceof Error ? error.message : String(error))
      }
    })
  }

  /** `GET /sessions/:id/turns/:turn` — o estado de um turno: rodando (com o que já saiu) ou terminado (o gravado). */
  async turnStatus(req: Request, res: Response) {
    await this.respond(res, async () => {
      const sessionId = req.params.id as string
      await this.requireOwnedSession(sessionId, { resume: true })
      const turn = Number(req.params.turn)
      if (!Number.isInteger(turn) || turn < 0) throw new HttpError(422, 'validation_error', 'turn: a non-negative integer')
      const live = this.liveTurns.get(sessionId)
      if (live?.turn === turn) return { conversationId: sessionId, turn, status: 'running' as const, text: live.text, tools: live.tools, durationMs: Date.now() - live.startedAt }
      const finished = this.finishedTurns.get(sessionId)
      if (finished?.turn === turn) return finished
      const stored = (await this.usecases.conversations.listTurns(sessionId)).find((item) => item.index === turn)
      if (!stored) throw new HttpError(404, 'not_found', `Turn not found: ${turn}`)
      return {
        conversationId: sessionId,
        turn,
        status: stored.aborted ? ('aborted' as const) : stored.error ? ('error' as const) : ('ok' as const),
        text: stored.text,
        tools: stored.toolCalls.map((call) => call.tool),
        ...(stored.error ? { error: stored.error } : {}),
        ...(stored.usage ? { usage: stored.usage } : {}),
        ...(stored.durationMs !== undefined ? { durationMs: stored.durationMs } : {}),
      }
    })
  }

  /** O turno em segundo plano: consome os eventos, guarda o resultado para o `GET` e avisa quem pediu. Nunca lança. */
  private async runTurn(sessionId: string, input: IMessageInput, live: ILiveTurn, callback: string | undefined): Promise<void> {
    const events: IAgentEvent[] = []
    let failure: string | undefined
    try {
      for await (const event of this.usecases.sendMessage.execute(sessionId, input)) {
        if (event.type === 'text.delta') live.text += event.payload.text
        else if (event.type === 'tool.started') live.tools.push(event.payload.tool)
        if (event.type !== 'text.delta' && event.type !== 'reasoning.delta') events.push(event)
      }
    } catch (error: unknown) {
      failure = toHttpFailure(error).message
    }
    const result = aggregateTurn(sessionId, events)
    const error = failure ?? result.error
    const status = result.aborted ? ('aborted' as const) : error ? ('error' as const) : ('ok' as const)
    const durationMs = Date.now() - live.startedAt
    // O gravado chega um instante depois (o `record` do use case é assíncrono): o resultado fica aqui para o `GET`.
    this.finishedTurns.set(sessionId, {
      conversationId: sessionId,
      turn: live.turn,
      status,
      text: live.text,
      tools: live.tools,
      ...(error ? { error } : {}),
      usage: result.usage,
      durationMs,
    })
    if (this.finishedTurns.size > 2000) this.finishedTurns.delete(this.finishedTurns.keys().next().value!)
    this.liveTurns.delete(sessionId)
    if (callback) void deliverCallback(callback, { conversationId: sessionId, turn: live.turn, status, ...(error ? { error } : {}), usage: result.usage, durationMs })
  }

  private async sendMessageAsJson(res: Response, sessionId: string, input: IMessageInput) {
    try {
      const events: IAgentEvent[] = []
      for await (const event of this.usecases.sendMessage.execute(sessionId, input)) {
        events.push(event)
      }
      res.json(ok(aggregateTurn(sessionId, events), 'Turn completed'))
    } catch (error: unknown) {
      this.sendFailure(res, error, '[AgentController.sendMessage]')
    }
  }

  private async sendMessageAsStream(res: Response, sessionId: string, input: IMessageInput) {
    const stream = new SseStream(res)
    stream.open()

    let finished = false
    // Fechar a aba tem de matar a geração no provider, senão o gateway segue queimando
    // token para uma resposta que ninguém vai ler.
    //
    // O listener vai em `res`, não em `req`: o `close` do request dispara assim que o
    // corpo do POST termina de ser lido, o que aqui é imediato — e cancelaria todo turno
    // antes do primeiro evento sair.
    res.on('close', () => {
      if (finished) return
      finished = true
      void this.usecases.cancelSession.execute(sessionId).catch(() => undefined)
    })

    try {
      for await (const event of this.usecases.sendMessage.execute(sessionId, input)) {
        if (finished) break
        stream.send(event)
      }
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      console.error('[AgentController.sendMessage] Error:', failure.message)
      stream.send({ type: 'error', sessionId, timestamp: new Date(), payload: { message: failure.message } })
    } finally {
      finished = true
      stream.close()
    }
  }

  /** Quem chamou, ou 401. Ver `resolveCaller` para o que passa. */
  private async requireCaller(): Promise<IResolvedCaller> {
    const resolved = await resolveCaller(this.usecases.proof)
    if (!resolved) throw unauthorized()

    return resolved
  }

  /**
   * A sessão existe E é do chamador — senão, a MESMA resposta para os dois casos.
   *
   * ⚠️ 404 igual para "não existe" e "não é sua": distinguir contaria a quem sondasse quais ids
   * existem. O 401 de quem não tem identidade aceita não distingue nada — vale para qualquer id.
   */
  /**
   * O dono da sessão, conferido. Com `resume` (mandar mensagem), a sessão que já não está na memória (expirou, ou o
   * gateway reiniciou) é RETOMADA da conversa gravada.
   * ⛔ O dono é conferido ANTES de reabrir, pela metadata gravada: ninguém retoma conversa alheia, e a resposta para
   * uma conversa alheia é a mesma de uma inexistente.
   */
  private async requireOwnedSession(sessionId: string, options: { resume?: boolean } = {}): Promise<IResolvedCaller> {
    const resolved = await this.requireCaller()

    let metadata: Record<string, unknown> | undefined
    try {
      metadata = (await this.usecases.getSession.execute(sessionId)).metadata
    } catch {
      const stored = options.resume && this.usecases.resumeSession ? await this.usecases.conversations.findSession(sessionId).catch(() => undefined) : undefined
      if (!stored || !ownsSession(resolved, stored.metadata)) throw new SessionNotFoundError(sessionId)
      await this.usecases.resumeSession!.execute(stored, (await checkAdminAccess(this.usecases.proof)).allowed)
      return resolved
    }

    if (!ownsSession(resolved, metadata)) throw new SessionNotFoundError(sessionId)

    return resolved
  }

  /** A tabela de preços em vigor. */
  private get pricing(): TModelPricing {
    return this.usecases.pricing ?? MODEL_PRICING
  }

  private get localTools(): string[] {
    return localToolPerimeter(this.usecases.catalog.localNames?.() ?? [])
  }

  /** Os preços de um provider: os do catálogo, ou a tabela de fábrica quando não há catálogo injetado. */
  private pricingOf(provider: string): TModelPricing {
    return this.usecases.models?.pricing(provider) ?? this.pricing
  }

  private viewFor(admin: boolean): IConversationView {
    return { admin, pricingOf: (provider) => this.pricingOf(provider) }
  }

  /**
   * A conversa gravada existe E é do chamador, ou ele é administrador — senão, a MESMA resposta
   * (404) para os dois casos.
   *
   * ⛔ FILTRAR A LISTAGEM NÃO PROTEGE NADA se o detalhe abre por id. Ids aparecem em log, em print, no
   * histórico do navegador de outra pessoa; sem esta conferência um deles é a conversa inteira de
   * outro. ⚠️ 404 igual para "não existe" e "não é sua": distinguir contaria quais ids existem.
   *
   * `admin` volta junto porque quem lê decide o que mostrar (custo, rótulo) pelo mesmo veredito.
   */
  private async requireConversationAccess(id: string) {
    const resolved = await this.requireCaller()
    const admin = (await checkAdminAccess(this.usecases.proof)).allowed

    const conversation = await this.usecases.conversations.findSession(id)
    if (!conversation || (!admin && !ownsSession(resolved, conversation.metadata))) throw new HttpError(404, 'not_found', `Conversation not found: ${id}`)

    return { resolved, admin, conversation }
  }

  /** A audiência configurada admite este chamador? Ver `allowsCaller` para a ordem das regras. */
  private async admits(resolved: IResolvedCaller): Promise<boolean> {
    const { audience } = await this.usecases.settings.read()

    return allowsCaller(audience, { identified: resolved.identity !== undefined, proven: resolved.proven, role: resolved.identity?.role }, audienceRules())
  }

  /**
   * Administrador, ou 404 — sem distinguir os motivos na resposta (ver `checkAdminAccess`).
   *
   * ⚠️ O motivo vai para o log: sem ele a diferença entre "não é administrador", "sem credencial" e
   * "a prova não rodou" — que mandam para lugares opostos — desaparece do relato.
   */
  private async requireAdmin(operation: string): Promise<NonNullable<Awaited<ReturnType<typeof checkAdminAccess>>['identity']>> {
    const access = await checkAdminAccess(this.usecases.proof)

    if (!access.allowed || !access.identity) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }

    return access.identity
  }

  /**
   * A listagem vem primeiro de propósito: é ela que pode reconectar, e ler o status antes
   * devolvia um `connected` sempre um passo atrás das tools que a própria resposta trazia.
   */
  private async catalogFor(allowed: string[], serves: (server: { projectId?: string }) => boolean) {
    const { catalog } = this.usecases
    const tools = await catalog.list(allowed)
    // Sem `lastError`: a mensagem pode trazer endereço interno, e esta rota é de qualquer chamador.
    // ⛔ Só os LIGADOS: o desligado não roda, e o nome dele não é assunto de quem não administra.
    // ⛔ E só os do escopo pedido (`serves`): o MCP de um projeto não aparece para quem não é dele.
    const servers = catalog.mcp
      .status()
      .filter((server) => server.enabled && serves(server))
      .map(({ key, id, projectId, name, enabled, connected }) => ({ key, id, ...(projectId ? { projectId } : {}), name, enabled, connected }))

    return { mcp: { connected: servers.some((server) => server.connected), servers }, tools }
  }

  /** Um lugar só para o envelope de sucesso e para a tradução de erro em status e código. */
  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      const result = await work()
      res.status(options.status ?? 200).json(ok(result, options.message))
    } catch (error: unknown) {
      this.sendFailure(res, error, '[AgentController]')
    }
  }

  private sendFailure(res: Response, error: unknown, scope: string) {
    const failure = toHttpFailure(error)
    if (failure.status >= 500) console.error(`${scope} Error:`, failure.message)
    res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
  }
}

/** O corpo validado vira o agente. O `id` vem de fora: do corpo na criação, do caminho na atualização. */
function toAgentInput(id: string, body: TAgentBody): IAgent {
  return {
    id,
    name: body.name,
    providers: body.providers.map((target) => ({
      provider: target.provider,
      models: [...new Set(target.models)],
      ...(target.sandbox ? { sandbox: target.sandbox } : {}),
      ...(target.network ? { network: true } : {}),
    })),
    systemPrompt: body.systemPrompt,
    ...(body.soul?.trim() ? { soul: body.soul.trim() } : {}),
    reasoningEfforts: body.reasoningEfforts?.length ? [...new Set(body.reasoningEfforts)] : undefined,
    modes: [...new Set(body.modes)],
    allowedTools: [...new Set(body.allowedTools)],
    ...(body.role ? { role: body.role } : {}),
    ...(body.adminOnly ? { adminOnly: true } : {}),
    ...(body.projectId ? { projectId: body.projectId } : {}),
    ...(body.permissions ? { permissions: body.permissions } : {}),
    ...(body.terminal && (body.terminal.timeoutSeconds || body.terminal.maxOutputChars) ? { terminal: body.terminal } : {}),
    ...(body.diagnostics && diagnosticsOn(body.diagnostics) ? { diagnostics: body.diagnostics } : {}),
    ...(body.triggers?.length ? { triggers: body.triggers.map((trigger) => ({ id: trigger.id.trim(), when: trigger.when.trim(), body: trigger.body })) } : {}),
    ...(body.env && Object.keys(body.env).length ? { env: { ...body.env } } : {}),
    // `global` é o padrão: não se grava.
    ...(body.fallback && body.fallback.mode !== 'global'
      ? { fallback: { mode: body.fallback.mode, ...(body.fallback.mode === 'own' ? { chain: body.fallback.chain ?? [] } : {}) } }
      : {}),
  }
}

function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
}
