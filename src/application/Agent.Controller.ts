import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { fail, ok } from '@infra/http/HttpResponse'
import { Request, Response } from 'express'

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
      res.write(`data: ${JSON.stringify({ type: 'error', payload: message })}\n\n`)
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

  async getAgents(req: Request, res: Response) {
    try {
      const { AGENT_REGISTRY } = require('@domain/AgentRegistry')
      res.json(ok(AGENT_REGISTRY, 'Agents retrieved successfully'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[AgentController.getAgents] Error:', message)
      res.status(500).json(fail(message))
    }
  }
}
