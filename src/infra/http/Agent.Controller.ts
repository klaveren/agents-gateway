import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { aggregateTurn } from '@application/Turn.Aggregator'
import { AGENT_REGISTRY, getAgentById } from '@domain/Agent.Registry'
import { AgentUnavailableError } from '@domain/errors/Domain.Error'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { allowsCaller, mergeSettings } from '@domain/models/Settings.Model'
import { ISettingsRepository } from '@domain/ports/SettingsRepository.Port'
import { ISessionContextProvider } from '@domain/ports/SessionContextProvider.Port'
import { SessionNotFoundError } from '@domain/errors/Domain.Error'
import { toAgentDto } from './Agent.Dto'
import { IResolvedCaller, ownerOf, ownsSession, resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { audienceRules } from './Caller.Roles'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { createSessionSchema, sendMessageSchema, updateSettingsSchema } from './Request.Schema'
import { toSessionDto } from './Session.Dto'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { SseStream } from './Sse.Stream'
import { NextFunction, Request, Response } from 'express'

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
  }

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
      return AGENT_REGISTRY.map(toAgentDto)
    })
  }

  async getAgentTools(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireCaller()
      const agentId = req.params.agentId as string
      const agent = getAgentById(agentId)
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
      const fallback = AGENT_REGISTRY[0]

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
        if (typeof body.agentId === 'string' && body.agentId && !getAgentById(body.agentId)) {
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

function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
}
