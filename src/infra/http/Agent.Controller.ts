import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { aggregateTurn } from '@application/Turn.Aggregator'
import { randomBytes } from 'node:crypto'
import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { IAgentRules } from '@domain/Agent.Policy'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { AgentUnavailableError } from '@domain/errors/Domain.Error'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { toSharedConversation } from '@domain/models/Conversation.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { allowsCaller, mergeSettings } from '@domain/models/Settings.Model'
import { IConversationEvents, TConversationEvent } from '@domain/ports/ConversationEvents.Port'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { ISessionContextProvider } from '@domain/ports/SessionContextProvider.Port'
import { SessionNotFoundError } from '@domain/errors/Domain.Error'
import { toAgentDetailDto, toAgentDto } from './Agent.Dto'
import { assertNoAdkTemplateCollision } from '@infra/adapters/GoogleAgent.Adapter'
import { providerOfModel } from '@infra/classifier/Classifier.Completion'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { IConversationView, toConversationDto, toStatsDto, toTurnDto } from './Conversation.Dto'
import { metadataFilter, parsePageQuery } from './Monitor.Query'
import { IResolvedCaller, ownerOf, ownsSession, resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { audienceRules } from './Caller.Roles'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { agentBodySchema, createSessionSchema, sendMessageSchema, shareConversationSchema, TAgentBody, updateSettingsSchema } from './Request.Schema'
import { toSessionDto } from './Session.Dto'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { SseStream } from './Sse.Stream'
import { NextFunction, Request, Response } from 'express'

/**
 * As tools LOCAIS que existem neste processo: as dos agentes EMBUTIDOS habilitados.
 *
 * ⛔ SÓ OS EMBUTIDOS, de propósito: é o perímetro de `AGENTS_ENABLED` (ver `IAgentRules.knownTools`).
 * Somar as dos agentes criados deixaria um agente criado ampliar o que outro pode receber.
 */
const ALL_LOCAL_TOOLS = [...new Set(AGENT_REGISTRY.flatMap((agent) => agent.allowedTools))]
const STARTED_AT = Date.now()

export interface IAgentControllerDeps {
  /** Injetado, e não buscado no singleton da composição: é o que torna o controller testável sem rede. */
  catalog: ToolCatalog
  createSession: CreateSessionUseCase
  sendMessage: SendMessageUseCase
  cancelSession: CancelSessionUseCase
  deleteSession: DeleteSessionUseCase
  getSession: GetSessionUseCase
  listSessions: ListSessionsUseCase
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
  /**
   * Os agentes: embutidos e criados. O MESMO catálogo do provider (ver `makeAgents`). Ausente, só os
   * embutidos, com os criados em memória.
   */
  agents?: AgentCatalog
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

export class AgentController {
  constructor(private readonly usecases: IAgentControllerDeps) {
    this.health = this.health.bind(this)
    this.getAgents = this.getAgents.bind(this)
    this.getAgentTools = this.getAgentTools.bind(this)
    this.getTools = this.getTools.bind(this)
    this.createSession = this.createSession.bind(this)
    this.listSessions = this.listSessions.bind(this)
    this.getSession = this.getSession.bind(this)
    this.deleteSession = this.deleteSession.bind(this)
    this.sendMessage = this.sendMessage.bind(this)
    this.cancelSession = this.cancelSession.bind(this)
    this.guardCaller = this.guardCaller.bind(this)
    this.availability = this.availability.bind(this)
    this.getSettings = this.getSettings.bind(this)
    this.updateSettings = this.updateSettings.bind(this)
    this.listConversations = this.listConversations.bind(this)
    this.conversationStats = this.conversationStats.bind(this)
    this.getConversationTurns = this.getConversationTurns.bind(this)
    this.shareConversation = this.shareConversation.bind(this)
    this.deleteConversation = this.deleteConversation.bind(this)
    this.getSharedConversation = this.getSharedConversation.bind(this)
    this.conversationEvents = this.conversationEvents.bind(this)
    this.getAgent = this.getAgent.bind(this)
    this.createAgent = this.createAgent.bind(this)
    this.updateAgent = this.updateAgent.bind(this)
    this.deleteAgent = this.deleteAgent.bind(this)
    this.agents = usecases.agents ?? new AgentCatalog(AGENT_REGISTRY, new NullAgentRepository())
  }

  private readonly agents: AgentCatalog

  async health(_req: Request, res: Response) {
    await this.respond(res, async () => {
      // Health é o lugar natural para tentar reconectar: quem monitora chama de tempos em
      // tempos, e com isso o MCP se recupera mesmo sem nenhum tráfego de tool.
      const connected = (await this.usecases.catalog.mcpEndpoint()) !== undefined

      return {
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
        mcp: { url: this.usecases.catalog.mcpUrl, connected },
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

  async getAgents(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireCaller()
      return this.agents.entries().map((entry) => toAgentDto(entry.agent, this.pricing, entry.builtIn))
    })
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

      return toAgentDetailDto(entry, this.pricing)
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

        const saved = this.agents.save(toAgentInput(body.id ?? '', body), { rules: await this.agentRules(), by: admin.email ?? admin.id ?? 'admin', creating: true })

        return toAgentDetailDto({ agent: saved, builtIn: false, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, this.pricing)
      },
      { status: 201, message: 'Agent created' },
    )
  }

  /** Substitui um agente criado. Embutido responde 409 (`agent_read_only`): duplica-se para editar. */
  async updateAgent(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateAgent')
        const body = parseBody(agentBodySchema, req.body)

        const saved = this.agents.save(toAgentInput(req.params.agentId as string, body), {
          rules: await this.agentRules(),
          by: admin.email ?? admin.id ?? 'admin',
          creating: false,
        })

        return toAgentDetailDto({ agent: saved, builtIn: false, updatedAt: saved.updatedAt, updatedBy: saved.updatedBy }, this.pricing)
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
        this.agents.remove(req.params.agentId as string)

        return null
      },
      { message: 'Agent deleted' },
    )
  }

  /**
   * Os fatos que a regra do agente precisa, lidos AGORA: as tools do catálogo neste instante (o MCP
   * pode ter subido ou caído) e o que cada provider recusa no prompt.
   *
   * ⚠️ O provider do modelo sai SÓ do prefixo do id (`providerOfModel(model, [])`): se viesse também
   * dos agentes declarados, um agente criado com um modelo trocado ensinaria a regra a aceitar o erro.
   */
  private async agentRules(): Promise<Omit<IAgentRules, 'takenIds'>> {
    const tools = await this.usecases.catalog.list(ALL_LOCAL_TOOLS)

    return {
      knownTools: tools.map((tool) => tool.name),
      providerOf: (model) => providerOfModel(model, []),
      promptIssue: (agent) => {
        if (agent.provider !== EProvider.GOOGLE) return undefined
        try {
          assertNoAdkTemplateCollision(agent.systemPrompt)
          return undefined
        } catch (error: unknown) {
          return error instanceof Error ? error.message : String(error)
        }
      },
    }
  }

  async getAgentTools(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireCaller()
      const agentId = req.params.agentId as string
      const agent = this.agents.get(agentId)
      if (!agent) throw new AgentNotFoundError(agentId)

      return this.catalogFor(agent.allowedTools)
    })
  }

  async getTools(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireCaller()
      return this.catalogFor(ALL_LOCAL_TOOLS)
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

        // ⛔ O `owner` do corpo é descartado SEMPRE. Dono só sai da credencial: aceitar o do corpo
        // seria deixar a pessoa declarar de quem é a sessão — e criar uma na conta de outra.
        const { owner: _declared, ...metadata } = body.metadata ?? {}
        const owner = ownerOf(resolved)

        return this.usecases.createSession.execute({ ...body, metadata: owner ? { ...metadata, owner } : metadata })
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

      return { ...(await this.usecases.settings.read()), defaults: { agentId: fallback?.id, model: fallback?.models[0] } }
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
  async conversationEvents(_req: Request, res: Response) {
    let resolved: IResolvedCaller
    let admin: boolean
    try {
      resolved = await this.requireCaller()
      admin = (await checkAdminAccess(this.usecases.proof)).allowed
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.conversationEvents]')
    }

    const stream = new SseStream(res)
    stream.open()
    stream.comment('ready')

    const view = this.viewFor(admin)
    const unsubscribe =
      this.usecases.events?.subscribe((event: TConversationEvent) => {
        const metadata = event.type === 'conversation.updated' ? event.session.metadata : event.metadata
        if (!admin && !ownsSession(resolved, metadata)) return

        if (event.type === 'conversation.updated') stream.emit(event.type, { session: toConversationDto(event.session, view) })
        else stream.emit(event.type, { sessionId: event.sessionId })
      }) ?? (() => undefined)

    // Em `res`, não em `req` — ver `sendMessageAsStream`: o `close` do request dispara cedo demais.
    res.on('close', () => {
      unsubscribe()
      stream.close()
    })
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

        return toStatsDto(await this.usecases.conversations.stats(), this.pricing)
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

        return { sessionId: id, turns: turns.map((turn) => toTurnDto(turn, conversation.model, view)) }
      },
      { message: 'Turns listed' },
    )
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

      return toSessionDto(await this.usecases.getSession.execute(id))
    })
  }

  async deleteSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = req.params.id as string
        await this.requireOwnedSession(id)

        await this.usecases.deleteSession.execute(id)
        return null
      },
      { message: 'Session deleted successfully' },
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
      resolved = await this.requireOwnedSession(sessionId)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }

    let body
    try {
      body = parseBody(sendMessageSchema, req.body)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }

    // O contexto sai da identidade já resolvida e é aplicado pelo use case, só na primeira mensagem.
    const context = this.usecases.sessionContext?.({ ...resolved.identity })
    const input: IMessageInput = { text: body.message, files: body.files, context }
    const wantsJson = req.accepts(['text/event-stream', 'application/json']) === 'application/json'

    return wantsJson ? this.sendMessageAsJson(res, sessionId, input) : this.sendMessageAsStream(res, sessionId, input)
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
  private async requireOwnedSession(sessionId: string): Promise<IResolvedCaller> {
    const resolved = await this.requireCaller()

    let metadata: Record<string, unknown> | undefined
    try {
      metadata = (await this.usecases.getSession.execute(sessionId)).metadata
    } catch {
      throw new SessionNotFoundError(sessionId)
    }

    if (!ownsSession(resolved, metadata)) throw new SessionNotFoundError(sessionId)

    return resolved
  }

  /** A tabela de preços em vigor. */
  private get pricing(): TModelPricing {
    return this.usecases.pricing ?? MODEL_PRICING
  }

  private viewFor(admin: boolean): IConversationView {
    return { admin, pricing: this.pricing }
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
  private async catalogFor(allowed: string[]) {
    const { catalog } = this.usecases
    const tools = await catalog.list(allowed)

    return { mcp: { url: catalog.mcpUrl, connected: catalog.mcpConnected }, tools }
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
    provider: body.provider,
    systemPrompt: body.systemPrompt,
    models: [...new Set(body.models)],
    reasoningEfforts: body.reasoningEfforts?.length ? [...new Set(body.reasoningEfforts)] : undefined,
    modes: [...new Set(body.modes)],
    allowedTools: [...new Set(body.allowedTools)],
  }
}

function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
}
