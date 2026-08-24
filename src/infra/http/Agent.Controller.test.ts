import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentNotFoundError, SessionNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { Request, Response } from 'express'
import { AgentController, IAgentControllerDeps } from './Agent.Controller'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'

interface IBody {
  ok: boolean
  message?: string
  code?: string
  details?: unknown
  result?: unknown
}

const record = (overrides: Partial<ISession> = {}): ISession => ({
  id: 'google-chat-1',
  agentId: 'researcher-agent',
  provider: EProvider.GOOGLE,
  mode: EMode.CHAT,
  model: 'gemini-3.7-flash',
  tools: false,
  createdAt: new Date(0),
  lastActivityAt: new Date(0),
  status: 'idle',
  turns: 2,
  usage: { inputTokens: 5, outputTokens: 7 },
  ...overrides,
})

describe('AgentController', () => {
  /** Catálogo falso: nenhum teste aqui abre socket. */
  const fakeCatalog = (connected = false) =>
    ({
      mcpUrl: 'http://localhost:8000/mcp',
      mcpConnected: connected,
      mcpGeneration: connected ? 1 : 0,
      mcpEndpoint: async () => (connected ? 'http://localhost:8000/mcp' : undefined),
      localFor: () => [],
      list: async () => [{ origin: 'local' as const, name: 'run_bash', description: '', inputSchema: {} }],
      invoke: async () => ({ status: 'success' as const, result: '' }),
    }) as unknown as ToolCatalog

  const controllerWith = (overrides: Partial<IAgentProvider> = {}, catalog = fakeCatalog()) => {
    const provider: IAgentProvider = {
      createSession: async () => ({ id: '123', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
      sendMessage: async function* () {
        yield { type: 'message.started', sessionId: '1', timestamp: new Date() }
      },
      cancel: async () => {},
      dispose: async () => {},
      describe: () => record(),
      list: () => [record()],
      ...overrides,
    }

    const deps: IAgentControllerDeps = {
      catalog,
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider),
      cancelSession: new CancelSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
    }

    return new AgentController(deps)
  }

  const mockRequest = (overrides: { params?: Record<string, string>; body?: unknown; accept?: string } = {}) =>
    ({
      params: overrides.params ?? {},
      body: overrides.body ?? {},
      query: {},
      headers: {},
      // O controller usa `accepts` para escolher entre SSE e JSON.
      accepts: (types: string[]) => types.find((type) => type === overrides.accept) ?? types[0],
    }) as unknown as Request

  const mockResponse = () => {
    const locals = {
      statusCode: 200,
      body: undefined as IBody | undefined,
      headers: {} as Record<string, string>,
      written: '',
      ended: false,
      flushed: false,
    }
    const listeners: Record<string, Array<() => void>> = {}

    const res: Partial<Response> = {
      status(code: number) {
        locals.statusCode = code
        return this as Response
      },
      json(data: IBody) {
        locals.body = data
        return this as Response
      },
      setHeader(name: string, value: string) {
        locals.headers[name] = value
        return this as Response
      },
      write(chunk: string) {
        locals.written += chunk
        return true
      },
      end() {
        locals.ended = true
        return this as Response
      },
      flushHeaders() {
        locals.flushed = true
      },
      on(event: string, listener: () => void) {
        ;(listeners[event] ??= []).push(listener)
        return this as Response
      },
    }

    return {
      res: res as Response,
      locals,
      emit: (event: string) => listeners[event]?.forEach((listener) => listener()),
    }
  }

  it('reports health with the MCP status and the live session count', async () => {
    const { res, locals } = mockResponse()
    await controllerWith({}, fakeCatalog(true)).health(mockRequest(), res)

    const result = locals.body?.result as { status: string; sessions: number; mcp: { connected: boolean } }
    assert.strictEqual(locals.body?.ok, true)
    assert.strictEqual(result.status, 'ok')
    assert.strictEqual(result.sessions, 1)
    assert.strictEqual(result.mcp.connected, true)
  })

  it('lets health retry the MCP connection, so it heals without any tool traffic', async () => {
    let attempts = 0
    const catalog = {
      mcpUrl: 'http://localhost:8000/mcp',
      mcpConnected: false,
      mcpEndpoint: async () => {
        attempts += 1
        return attempts > 1 ? 'http://localhost:8000/mcp' : undefined
      },
    } as unknown as ToolCatalog

    const controller = controllerWith({}, catalog)

    const first = mockResponse()
    await controller.health(mockRequest(), first.res)
    assert.strictEqual((first.locals.body?.result as { mcp: { connected: boolean } }).mcp.connected, false)

    const second = mockResponse()
    await controller.health(mockRequest(), second.res)
    assert.strictEqual((second.locals.body?.result as { mcp: { connected: boolean } }).mcp.connected, true)
  })

  it('lists the agents with their lanes', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().getAgents(mockRequest(), res)

    const agents = locals.body?.result as Array<{ modes: string[] }>
    assert.ok(agents.length > 0)
    assert.ok(agents.every((agent) => agent.modes.length > 0))
  })

  it('404s the tool catalog of an agent that does not exist', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().getAgentTools(mockRequest({ params: { agentId: 'nope' } }), res)

    assert.strictEqual(locals.statusCode, 404)
    assert.strictEqual(locals.body?.code, 'agent_not_found')
  })

  it('creates a session with 201', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().createSession(mockRequest({ body: { agentId: 'researcher-agent' } }), res)

    assert.strictEqual(locals.statusCode, 201)
    assert.strictEqual((locals.body?.result as { id: string }).id, '123')
  })

  it('rejects an invalid body with 422 and points at the field', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().createSession(mockRequest({ body: {} }), res)

    assert.strictEqual(locals.statusCode, 422)
    assert.strictEqual(locals.body?.code, 'validation_error')
    assert.deepStrictEqual(locals.body?.details, [{ field: 'agentId', message: 'agentId is required' }])
  })

  it('maps a domain failure to its own status and code', async () => {
    const { res, locals } = mockResponse()
    const controller = controllerWith({
      createSession: async () => {
        throw new AgentNotFoundError('ghost')
      },
    })

    await controller.createSession(mockRequest({ body: { agentId: 'ghost' } }), res)

    assert.strictEqual(locals.statusCode, 404)
    assert.strictEqual(locals.body?.code, 'agent_not_found')
  })

  it('never leaks the adapter native state in a session response', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().getSession(mockRequest({ params: { id: 'google-chat-1' } }), res)

    const session = locals.body?.result as Record<string, unknown>
    assert.strictEqual(session.turns, 2)
    assert.deepStrictEqual(session.usage, { inputTokens: 5, outputTokens: 7 })
    assert.strictEqual('native' in session, false)
    assert.strictEqual('abort' in session, false)
    assert.strictEqual('systemPrompt' in session, false)
  })

  it('404s a session that is gone', async () => {
    const { res, locals } = mockResponse()
    const controller = controllerWith({
      describe: () => {
        throw new SessionNotFoundError('gone')
      },
    })

    await controller.getSession(mockRequest({ params: { id: 'gone' } }), res)

    assert.strictEqual(locals.statusCode, 404)
    assert.strictEqual(locals.body?.code, 'session_not_found')
  })

  it('deletes a session', async () => {
    const disposed: string[] = []
    const { res, locals } = mockResponse()
    const controller = controllerWith({ dispose: async (id) => void disposed.push(id) })

    await controller.deleteSession(mockRequest({ params: { id: 'google-chat-1' } }), res)

    assert.deepStrictEqual(disposed, ['google-chat-1'])
    assert.strictEqual(locals.body?.ok, true)
  })

  it('streams by default, with headers a proxy will not buffer', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().sendMessage(mockRequest({ params: { id: 's1' }, body: { message: 'hi' } }), res)

    assert.strictEqual(locals.headers['Content-Type'], 'text/event-stream')
    assert.strictEqual(locals.headers['X-Accel-Buffering'], 'no')
    assert.strictEqual(locals.flushed, true)
    assert.match(locals.written, /^id: 1\nevent: message\.started\ndata: \{/)
    assert.strictEqual(locals.ended, true)
  })

  it('aggregates the turn into JSON when the client asks for it', async () => {
    const events: IAgentEvent[] = [
      { type: 'text.delta', sessionId: 's1', timestamp: new Date(), payload: { text: 'ok' } },
      { type: 'tool.started', sessionId: 's1', timestamp: new Date(), payload: { tool: 'run_bash', args: {} } },
      { type: 'tool.result', sessionId: 's1', timestamp: new Date(), payload: { tool: 'run_bash', result: 'done' } },
      { type: 'usage', sessionId: 's1', timestamp: new Date(), payload: { outputTokens: 9 } },
    ]

    const { res, locals } = mockResponse()
    const controller = controllerWith({
      sendMessage: async function* () {
        for (const event of events) yield event
      },
    })

    await controller.sendMessage(mockRequest({ params: { id: 's1' }, body: { message: 'hi' }, accept: 'application/json' }), res)

    const turn = locals.body?.result as { text: string; toolCalls: Array<{ tool: string; result: unknown }> }
    assert.strictEqual(locals.headers['Content-Type'], undefined, 'não deve abrir stream')
    assert.strictEqual(turn.text, 'ok')
    assert.deepStrictEqual(turn.toolCalls, [{ tool: 'run_bash', args: {}, result: 'done' }])
  })

  it('rejects a turn with neither text nor attachment', async () => {
    const { res, locals } = mockResponse()
    await controllerWith().sendMessage(mockRequest({ params: { id: 's1' }, body: { message: '  ' } }), res)

    assert.strictEqual(locals.statusCode, 422)
    assert.strictEqual(locals.body?.code, 'validation_error')
    assert.strictEqual(locals.ended, false, 'não deve abrir stream para pedido inválido')
  })

  it('cancels the provider stream when the client disconnects', async () => {
    let cancelled = 0
    let disconnect: () => void = () => {}

    const controller = controllerWith({
      cancel: async () => {
        cancelled += 1
      },
      sendMessage: async function* () {
        yield { type: 'text.delta' as const, sessionId: 's1', timestamp: new Date(), payload: { text: 'first' } }
        disconnect()
        yield { type: 'text.delta' as const, sessionId: 's1', timestamp: new Date(), payload: { text: 'second' } }
      },
    })

    const { res, locals, emit } = mockResponse()
    disconnect = () => emit('close')

    await controller.sendMessage(mockRequest({ params: { id: 's1' }, body: { message: 'hi' } }), res)

    assert.strictEqual(cancelled, 1)
    assert.ok(locals.written.includes('first'))
    assert.ok(!locals.written.includes('second'), 'nada deve ser escrito depois do disconnect')
  })

  it('cancels a session by id alone', async () => {
    const seen: string[] = []
    const { res, locals } = mockResponse()
    const controller = controllerWith({ cancel: async (id) => void seen.push(id) })

    await controller.cancelSession(mockRequest({ params: { id: 'sess-9' } }), res)

    assert.deepStrictEqual(seen, ['sess-9'])
    assert.strictEqual(locals.body?.ok, true)
  })
})
