import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { AGENT_REGISTRY, getAgentById } from '@domain/Agent.Registry'
import { makeTools } from '@composition/factories/Tools.Factory'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { fail, ok } from '@infra/http/Http.Response'
import { Request, Response } from 'express'

const ALL_LOCAL_TOOLS = [...new Set(AGENT_REGISTRY.flatMap((agent) => agent.allowedTools))]

export class AgentController {
  constructor(
    private createSessionUseCase: CreateSessionUseCase,
    private sendMessageUseCase: SendMessageUseCase,
    private cancelSessionUseCase: CancelSessionUseCase,
  ) {
    this.createSession = this.createSession.bind(this)
    this.sendMessage = this.sendMessage.bind(this)
    this.cancelSession = this.cancelSession.bind(this)
    this.getAgents = this.getAgents.bind(this)
    this.getTools = this.getTools.bind(this)
  }

  async createSession(req: Request, res: Response) {
    try {
      const session = await this.createSessionUseCase.execute(req.body)
      res.status(201).json(ok(session, 'Session created successfully'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.createSession] Error:', message)
      res.status(500).json(fail(message))
    }
  }

  async sendMessage(req: Request, res: Response) {
    const agentId = req.params.agentId as string
    const id = req.params.id as string
    const { message, files } = req.body

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    try {
      const events = this.sendMessageUseCase.execute(agentId, id, { text: message, files })
      for await (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.end()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.sendMessage] Error:', message)
      const event: IAgentEvent = { type: 'error', sessionId: id, timestamp: new Date(), payload: { message } }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    }
  }

  async cancelSession(req: Request, res: Response) {
    try {
      const agentId = req.params.agentId as string
      const id = req.params.id as string
      await this.cancelSessionUseCase.execute(agentId, id)
      res.json(ok(null, 'Session cancelled successfully'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.cancelSession] Error:', message)
      res.status(500).json(fail(message))
    }
  }

  /** Mostra o catálogo unido: as tools locais e as que vieram do MCP server. */
  async getTools(req: Request, res: Response) {
    try {
      const { catalog } = makeTools()
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined
      const allowed = agentId ? (getAgentById(agentId)?.allowedTools ?? []) : ALL_LOCAL_TOOLS

      res.json(ok({ mcp: { url: catalog.mcpUrl, connected: catalog.mcpConnected }, tools: await catalog.list(allowed) }, 'Tools retrieved successfully'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.getTools] Error:', message)
      res.status(500).json(fail(message))
    }
  }

  async getAgents(req: Request, res: Response) {
    try {
      res.json(ok(AGENT_REGISTRY, 'Agents retrieved successfully'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.getAgents] Error:', message)
      res.status(500).json(fail(message))
    }
  }
}
