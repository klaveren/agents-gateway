import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AgentController } from './Agent.Controller'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { SendMessageUseCase } from './SendMessage.Usecase'
import { CancelSessionUseCase } from './CancelSession.Usecase'
import { IAgentProvider } from '@domain/ports/AgentProvider'
import { EProvider } from '@domain/enums/EProvider'
import { Request, Response } from 'express'

describe('AgentController', () => {
  const getMockController = (overrides?: Partial<IAgentProvider>) => {
    const mockProvider: IAgentProvider = {
      createSession: async () => ({ id: '123', provider: EProvider.OPENAI, createdAt: new Date() }),
      sendMessage: async function* () {
        yield { type: 'message.started', sessionId: '1', timestamp: new Date() }
      },
      cancel: async () => {},
      ...overrides,
    }

    return new AgentController(new CreateSessionUseCase(mockProvider), new SendMessageUseCase(mockProvider), new CancelSessionUseCase(mockProvider))
  }

  // Type-safe mock request builder
  const createMockRequest = (overrides?: Partial<Request>): Request => {
    return {
      body: {},
      params: {},
      ...overrides,
    } as Request
  }

  // Type-safe mock response builder
  const createMockResponse = () => {
    const locals: {
      statusCode?: number
      jsonData?: { ok: boolean; result: unknown[] | Record<string, unknown> | null }
      headers: Record<string, string | string[]>
      written: string
      ended: boolean
    } = {
      headers: {},
      written: '',
      ended: false,
    }

    const res: Partial<Response> = {
      status: function (code: number) {
        locals.statusCode = code
        return this as Response
      },
      json: function (data: { ok: boolean; result: unknown[] | Record<string, unknown> | null }) {
        locals.jsonData = data
        return this as Response
      },
      setHeader: function (name: string, value: string | string[]) {
        locals.headers[name] = value
        return this as Response
      },
      write: function (data: string) {
        locals.written += data
        return true
      },
      end: function () {
        locals.ended = true
        return this as Response
      },
    }

    return { res: res as Response, locals }
  }

  it('should list agents', async () => {
    const controller = getMockController()
    const req = createMockRequest()
    const { res, locals } = createMockResponse()

    await controller.getAgents(req, res)
    assert.ok(locals.jsonData)
    assert.ok(locals.jsonData.ok)
    assert.ok(Array.isArray(locals.jsonData.result))
  })

  it('should handle getAgents error', async () => {
    const controller = getMockController()
    const req = createMockRequest()
    const { res, locals } = createMockResponse()

    let count = 0
    res.json = (data: { ok: boolean; result: unknown[] | Record<string, unknown> | null }) => {
      if (count === 0) {
        count++
        throw new Error('Simulated error')
      }
      locals.jsonData = data
      return res as Response
    }

    await controller.getAgents(req, res)
    assert.strictEqual(locals.statusCode, 500)
    assert.strictEqual(locals.jsonData?.ok, false)
  })

  it('should create a session successfully', async () => {
    const controller = getMockController()
    const req = createMockRequest({ body: { agentId: 'researcher-agent' } })
    const { res, locals } = createMockResponse()

    await controller.createSession(req, res)
    assert.strictEqual(locals.statusCode, 201)
    assert.ok(locals.jsonData)
    assert.strictEqual((locals.jsonData.result as { id: string }).id, '123')
  })

  it('should handle createSession error', async () => {
    const controller = getMockController({
      createSession: async () => {
        throw new Error('Failed')
      },
    })
    const req = createMockRequest({ body: {} })
    const { res, locals } = createMockResponse()

    await controller.createSession(req, res)
    assert.strictEqual(locals.statusCode, 500)
    assert.ok(locals.jsonData)
    assert.strictEqual(locals.jsonData.ok, false)
  })

  it('should send messages and stream response', async () => {
    const controller = getMockController()
    const req = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals } = createMockResponse()

    await controller.sendMessage(req, res)
    assert.strictEqual(locals.headers['Content-Type'], 'text/event-stream')
    assert.ok(locals.written.includes('message.started'))
    assert.strictEqual(locals.ended, true)
  })

  it('should handle sendMessage error', async () => {
    const controller = getMockController({
      // eslint-disable-next-line require-yield
      sendMessage: async function* () {
        throw new Error('Stream failed')
      },
    })
    const req = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals } = createMockResponse()

    await controller.sendMessage(req, res)
    assert.ok(locals.written.includes('error'))
    assert.ok(locals.written.includes('Stream failed'))
    assert.strictEqual(locals.ended, true)
  })

  it('should cancel a session successfully', async () => {
    const controller = getMockController()
    const req = createMockRequest({ params: { agentId: 'a', id: '1' } })
    const { res, locals } = createMockResponse()

    await controller.cancelSession(req, res)
    assert.ok(locals.jsonData)
    assert.strictEqual(locals.jsonData.ok, true)
  })

  it('should handle cancelSession error', async () => {
    const controller = getMockController({
      cancel: async () => {
        throw new Error('Cancel failed')
      },
    })
    const req = createMockRequest({ params: {} })
    const { res, locals } = createMockResponse()

    await controller.cancelSession(req, res)
    assert.strictEqual(locals.statusCode, 500)
    assert.ok(locals.jsonData)
    assert.strictEqual(locals.jsonData.ok, false)
  })
})
