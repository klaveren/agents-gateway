import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { aggregateTurn } from '@application/Turn.Aggregator'
import { AGENT_REGISTRY, getAgentById } from '@domain/Agent.Registry'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { createSessionSchema, sendMessageSchema } from './Request.Schema'
import { toSessionDto } from './Session.Dto'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { SseStream } from './Sse.Stream'
import { Request, Response } from 'express'

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

  async getAgents(_req: Request, res: Response) {
    await this.respond(res, async () => AGENT_REGISTRY)
  }

  async getAgentTools(req: Request, res: Response) {
    await this.respond(res, async () => {
      const agentId = req.params.agentId as string
      const agent = getAgentById(agentId)
      if (!agent) throw new AgentNotFoundError(agentId)

      return this.catalogFor(agent.allowedTools)
    })
  }

  async getTools(_req: Request, res: Response) {
    await this.respond(res, async () => this.catalogFor(ALL_LOCAL_TOOLS))
  }

  async createSession(req: Request, res: Response) {
    await this.respond(res, async () => this.usecases.createSession.execute(parseBody(createSessionSchema, req.body)), { status: 201, message: 'Session created successfully' })
  }

  async listSessions(_req: Request, res: Response) {
    await this.respond(res, async () => (await this.usecases.listSessions.execute()).map(toSessionDto))
  }

  async getSession(req: Request, res: Response) {
    await this.respond(res, async () => toSessionDto(await this.usecases.getSession.execute(req.params.id as string)))
  }

  async deleteSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.usecases.deleteSession.execute(req.params.id as string)
        return null
      },
      { message: 'Session deleted successfully' },
    )
  }

  async cancelSession(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        await this.usecases.cancelSession.execute(req.params.id as string)
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

    let body
    try {
      body = parseBody(sendMessageSchema, req.body)
    } catch (error: unknown) {
      return this.sendFailure(res, error, '[AgentController.sendMessage]')
    }

    const input: IMessageInput = { text: body.message, files: body.files }
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
