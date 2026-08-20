import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AgentController } from './Agent.Controller'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { SendMessageUseCase } from './SendMessage.Usecase'
import { CancelSessionUseCase } from './CancelSession.Usecase'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { Request, Response } from 'express'

describe('AgentController', () => {
  const getMockController = (overrides?: Partial<IAgentProvider>) => {
    const mockProvider: IAgentProvider = {
      createSession: async () => ({ id: '123', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
      sendMessage: async function* () {
        yield { type: 'message.started', sessionId: '1', timestamp: new Date() }
      },
      cancel: async () => {},
      ...overrides,
    }

    return new AgentController(new CreateSessionUseCase(mockProvider), new SendMessageUseCase(mockProvider), new CancelSessionUseCase(mockProvider))
  }

  // Type-safe mock request builder. `on` guarda os listeners para o teste poder
  // simular a aba fechando no meio do stream.
  const createMockRequest = (overrides?: Partial<Request>) => {
    const req = { body: {}, params: {}, query: {}, ...overrides } as unknown as Request
    return { req }
  }

  // Type-safe mock response builder
  const createMockResponse = () => {
    const locals: {
      statusCode?: number
      jsonData?: { ok: boolean; result: unknown[] | Record<string, unknown> | null }
      headers: Record<string, string | string[]>
      written: string
      ended: boolean
      flushed: boolean
    } = {
      headers: {},
      written: '',
      ended: false,
      flushed: false,
    }

    const listeners: Record<string, Array<() => void>> = {}

    const res: Partial<Response> = {
      // O disconnect do cliente chega por `res`, não por `req`.
      on: function (event: string, listener: () => void) {
        ;(listeners[event] ??= []).push(listener)
        return this as Response
      },
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
      flushHeaders: function () {
        locals.flushed = true
      },
    }

    return {
      res: res as Response,
      locals,
      emit: (event: string) => listeners[event]?.forEach((listener) => listener()),
    }
  }

  it('should list agents', async () => {
    const controller = getMockController()
    const { req } = createMockRequest()
    const { res, locals } = createMockResponse()

    await controller.getAgents(req, res)
    assert.ok(locals.jsonData)
    assert.ok(locals.jsonData.ok)
    assert.ok(Array.isArray(locals.jsonData.result))
  })

  it('should handle getAgents error', async () => {
    const controller = getMockController()
    const { req } = createMockRequest()
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
    const { req } = createMockRequest({ body: { agentId: 'researcher-agent' } })
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
    const { req } = createMockRequest({ body: {} })
    const { res, locals } = createMockResponse()

    await controller.createSession(req, res)
    assert.strictEqual(locals.statusCode, 500)
    assert.ok(locals.jsonData)
    assert.strictEqual(locals.jsonData.ok, false)
  })

  it('should send messages and stream response', async () => {
    const controller = getMockController()
    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
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
    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals } = createMockResponse()

    await controller.sendMessage(req, res)
    assert.ok(locals.written.includes('error'))
    assert.ok(locals.written.includes('Stream failed'))
    assert.strictEqual(locals.ended, true)
  })

  it('should set the streaming headers a proxy will not buffer', async () => {
    const controller = getMockController()
    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals } = createMockResponse()

    await controller.sendMessage(req, res)

    assert.strictEqual(locals.headers['Content-Type'], 'text/event-stream')
    assert.strictEqual(locals.headers['X-Accel-Buffering'], 'no')
    assert.strictEqual(locals.headers['Cache-Control'], 'no-cache, no-transform')
    assert.strictEqual(locals.flushed, true)
  })

  it('should frame each event with an id and a name', async () => {
    const controller = getMockController()
    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals } = createMockResponse()

    await controller.sendMessage(req, res)

    assert.match(locals.written, /^id: 1\nevent: message\.started\ndata: \{/)
    assert.strictEqual(locals.ended, true)
  })

  it('should cancel the provider stream when the client disconnects', async () => {
    let cancelled = 0
    let disconnect: () => void = () => {}

    const controller = getMockController({
      cancel: async () => {
        cancelled += 1
      },
      sendMessage: async function* () {
        yield { type: 'text.delta' as const, sessionId: '1', timestamp: new Date(), payload: { text: 'first' } }
        // A aba fecha no meio do turno.
        disconnect()
        yield { type: 'text.delta' as const, sessionId: '1', timestamp: new Date(), payload: { text: 'second' } }
      },
    })

    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' }, body: { message: 'hello' } })
    const { res, locals, emit } = createMockResponse()
    disconnect = () => emit('close')

    await controller.sendMessage(req, res)

    assert.strictEqual(cancelled, 1)
    assert.ok(locals.written.includes('first'))
    assert.ok(!locals.written.includes('second'), 'nada deve ser escrito depois do disconnect')
    assert.strictEqual(locals.ended, true)
  })

  it('should cancel a session successfully', async () => {
    const controller = getMockController()
    const { req } = createMockRequest({ params: { agentId: 'a', id: '1' } })
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
    const { req } = createMockRequest({ params: {} })
    const { res, locals } = createMockResponse()

    await controller.cancelSession(req, res)
    assert.strictEqual(locals.statusCode, 500)
    assert.ok(locals.jsonData)
    assert.strictEqual(locals.jsonData.ok, false)
  })
})
