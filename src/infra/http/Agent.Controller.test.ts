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
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { ICallerProof } from './Caller.Proof'

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

  const controllerWith = (overrides: Partial<IAgentProvider> = {}, catalog = fakeCatalog(), proof?: ICallerProof) => {
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
      sendMessage: new SendMessageUseCase(provider, new NullConversationRepository()),
      cancelSession: new CancelSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      proof,
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
    await controllerWith().createSession(mockRequest({ body: { mode: 'nope' } }), res)

    assert.strictEqual(locals.statusCode, 422)
    assert.strictEqual(locals.body?.code, 'validation_error')
    assert.deepStrictEqual(locals.body?.details, [{ field: 'mode', message: 'Invalid option: expected one of "chat"|"agent"' }])
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

  /**
   * Dono, identidade e prova.
   *
   * A prova é um dublê: aprova só o token `good-*`. O que está sob teste é o que o controller faz com
   * a resposta dela — a estratégia em si tem teste próprio em `Caller.Proof.test.ts`.
   */
  describe('dono da sessão', () => {
    const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') }
    const ALICE = { token: 'good-alice', id: 'alice', email: 'a@x.test', account: 'acc-1' }
    const BOB = { token: 'good-bob', id: 'bob', account: 'acc-1' }
    const FORGED_ALICE = { token: 'forged-alice', id: 'alice', account: 'acc-1' }

    const owned = (id: string, owner: object | undefined) => record({ id, metadata: owner ? { owner } : undefined })
    const aliceSession = owned('s-alice', { id: 'alice', email: 'a@x.test', account: 'acc-1' })

    const withAlice = (overrides: Partial<IAgentProvider> = {}) => controllerWith({ describe: () => aliceSession, list: () => [aliceSession], ...overrides }, fakeCatalog(), proof)

    it('carimba o dono provado na criação, e descarta o `owner` que veio no corpo', async () => {
      let received: { metadata?: Record<string, unknown> } | undefined
      const controller = controllerWith(
        {
          createSession: async (input) => {
            received = input
            return { id: 'new', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }
          },
        },
        fakeCatalog(),
        proof,
      )

      const { res, locals } = mockResponse()
      await withCaller(ALICE, () => controller.createSession(mockRequest({ body: { metadata: { owner: { id: 'bob' }, tag: 'x' } } }), res))

      assert.strictEqual(locals.statusCode, 201)
      assert.deepStrictEqual(received?.metadata, { tag: 'x', owner: { id: 'alice', email: 'a@x.test', account: 'acc-1' } })
    })

    it('a sessão anônima nasce sem dono, mesmo que o corpo declare um', async () => {
      let received: { metadata?: Record<string, unknown> } | undefined
      const controller = controllerWith({
        createSession: async (input) => {
          received = input
          return { id: 'new', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }
        },
      })

      const { res } = mockResponse()
      await controller.createSession(mockRequest({ body: { metadata: { owner: { id: 'alice' } } } }), res)

      assert.deepStrictEqual(received?.metadata, {})
    })

    it('401 ao criar com credencial que a prova recusa', async () => {
      const { res, locals } = mockResponse()
      await withCaller(FORGED_ALICE, () => withAlice().createSession(mockRequest({ body: {} }), res))

      assert.strictEqual(locals.statusCode, 401)
    })

    it('o dono enxerga a própria sessão', async () => {
      const { res, locals } = mockResponse()
      await withCaller(ALICE, () => withAlice().getSession(mockRequest({ params: { id: 's-alice' } }), res))

      assert.strictEqual(locals.statusCode, 200)
      assert.strictEqual((locals.body?.result as { id: string }).id, 's-alice')
    })

    it('404 para outro usuário provado em get, delete, cancel e sendMessage — e nada é executado', async () => {
      const calls: string[] = []
      const controller = withAlice({
        dispose: async () => void calls.push('dispose'),
        cancel: async () => void calls.push('cancel'),
        sendMessage: async function* () {
          calls.push('sendMessage')
          yield { type: 'message.started' as const, sessionId: 's-alice', timestamp: new Date() }
        },
      })

      const outcomes = await Promise.all(
        (
          [
            (res: Response) => controller.getSession(mockRequest({ params: { id: 's-alice' } }), res),
            (res: Response) => controller.deleteSession(mockRequest({ params: { id: 's-alice' } }), res),
            (res: Response) => controller.cancelSession(mockRequest({ params: { id: 's-alice' } }), res),
            (res: Response) => controller.sendMessage(mockRequest({ params: { id: 's-alice' }, body: { message: 'oi' }, accept: 'application/json' }), res),
          ] as const
        ).map(async (call) => {
          const { res, locals } = mockResponse()
          await withCaller(BOB, () => call(res))
          return locals
        }),
      )

      for (const locals of outcomes) {
        assert.strictEqual(locals.statusCode, 404)
        assert.strictEqual(locals.body?.code, 'session_not_found')
      }
      assert.deepStrictEqual(calls, [])
    })

    it('a sessão de outro e a que não existe respondem IGUAL — não conta quais ids existem', async () => {
      const gone = controllerWith(
        {
          describe: () => {
            throw new SessionNotFoundError('s-alice')
          },
        },
        fakeCatalog(),
        proof,
      )
      const other = mockResponse()
      const missing = mockResponse()

      await withCaller(BOB, () => withAlice().getSession(mockRequest({ params: { id: 's-alice' } }), other.res))
      await withCaller(BOB, () => gone.getSession(mockRequest({ params: { id: 's-alice' } }), missing.res))

      assert.strictEqual(other.locals.statusCode, missing.locals.statusCode)
      assert.deepStrictEqual(other.locals.body, missing.locals.body)
    })

    it('mesma pessoa em OUTRA conta não alcança a sessão da conta anterior', async () => {
      const { res, locals } = mockResponse()
      await withCaller({ ...ALICE, account: 'acc-2' }, () => withAlice().getSession(mockRequest({ params: { id: 's-alice' } }), res))

      assert.strictEqual(locals.statusCode, 404)
    })

    it('token forjado com o id do dono (prova recusa) não alcança a sessão: 401', async () => {
      const calls: string[] = []
      const controller = withAlice({ cancel: async () => void calls.push('cancel') })

      for (const run of [
        (res: Response) => controller.getSession(mockRequest({ params: { id: 's-alice' } }), res),
        (res: Response) => controller.cancelSession(mockRequest({ params: { id: 's-alice' } }), res),
        (res: Response) => controller.sendMessage(mockRequest({ params: { id: 's-alice' }, body: { message: 'oi' }, accept: 'application/json' }), res),
      ]) {
        const { res, locals } = mockResponse()
        await withCaller(FORGED_ALICE, () => run(res))
        assert.strictEqual(locals.statusCode, 401)
      }
      assert.deepStrictEqual(calls, [])
    })

    it('o anônimo não alcança sessão com dono, e o dono não alcança a sessão sem dono', async () => {
      const ownerless = owned('s-local', undefined)
      const controller = controllerWith({ describe: (id) => (id === 's-local' ? ownerless : aliceSession) }, fakeCatalog(), proof)

      const anon = mockResponse()
      await controller.getSession(mockRequest({ params: { id: 's-alice' } }), anon.res)
      assert.strictEqual(anon.locals.statusCode, 404)

      const local = mockResponse()
      await controller.getSession(mockRequest({ params: { id: 's-local' } }), local.res)
      assert.strictEqual(local.locals.statusCode, 200)

      const mine = mockResponse()
      await withCaller(ALICE, () => controller.getSession(mockRequest({ params: { id: 's-local' } }), mine.res))
      assert.strictEqual(mine.locals.statusCode, 404)
    })

    it('GET /sessions lista só as do próprio chamador', async () => {
      const controller = controllerWith({ list: () => [aliceSession, owned('s-bob', { id: 'bob', account: 'acc-1' }), owned('s-local', undefined)] }, fakeCatalog(), proof)

      const { res, locals } = mockResponse()
      await withCaller(BOB, () => controller.listSessions(mockRequest(), res))

      assert.deepStrictEqual(
        (locals.body?.result as Array<{ id: string }>).map((session) => session.id),
        ['s-bob'],
      )
    })

    it('GET /sessions com credencial recusada é 401, nunca "todas"', async () => {
      const { res, locals } = mockResponse()
      await withCaller(FORGED_ALICE, () => withAlice().listSessions(mockRequest(), res))

      assert.strictEqual(locals.statusCode, 401)
      assert.strictEqual(locals.body?.result, undefined)
    })

    it('credencial sem id legível nunca vira anônimo (não cai no escopo "sem dono")', async () => {
      const controller = controllerWith({ list: () => [owned('s-local', undefined)] }, fakeCatalog(), proof)

      const { res, locals } = mockResponse()
      await withCaller({ token: 'good-sem-id' }, () => controller.listSessions(mockRequest(), res))

      assert.strictEqual(locals.statusCode, 401)
    })

    describe('prova desligada', () => {
      const claimed = () => controllerWith({ describe: () => aliceSession, list: () => [aliceSession] })

      it('por padrão (REQUIRE_PROVEN_OWNER) a identidade só afirmada é recusada em toda rota de identidade', async () => {
        delete process.env.REQUIRE_PROVEN_OWNER

        for (const run of [
          (res: Response) => claimed().getAgents(mockRequest(), res),
          (res: Response) => claimed().getTools(mockRequest(), res),
          (res: Response) => claimed().createSession(mockRequest({ body: {} }), res),
          (res: Response) => claimed().listSessions(mockRequest(), res),
          (res: Response) => claimed().getSession(mockRequest({ params: { id: 's-alice' } }), res),
        ]) {
          const { res, locals } = mockResponse()
          await withCaller(ALICE, () => run(res))
          assert.strictEqual(locals.statusCode, 401)
        }
      })

      it('com REQUIRE_PROVEN_OWNER=0 a identidade afirmada vale como dono', async () => {
        process.env.REQUIRE_PROVEN_OWNER = '0'
        try {
          const own = mockResponse()
          await withCaller(ALICE, () => claimed().getSession(mockRequest({ params: { id: 's-alice' } }), own.res))
          assert.strictEqual(own.locals.statusCode, 200)

          const other = mockResponse()
          await withCaller(BOB, () => claimed().getSession(mockRequest({ params: { id: 's-alice' } }), other.res))
          assert.strictEqual(other.locals.statusCode, 404)
        } finally {
          delete process.env.REQUIRE_PROVEN_OWNER
        }
      })
    })

    describe('agentes e ferramentas', () => {
      it('GET /agents nunca expõe o systemPrompt, nem nenhum campo fora da lista', async () => {
        const { res, locals } = mockResponse()
        await withCaller(ALICE, () => controllerWith({}, fakeCatalog(), proof).getAgents(mockRequest(), res))

        const agents = locals.body?.result as Array<Record<string, unknown>>
        assert.ok(agents.length > 0)
        for (const agent of agents) {
          assert.strictEqual('systemPrompt' in agent, false)
          // O que sai é o JSON: `reasoningEfforts: undefined` não conta como campo.
          assert.ok(Object.keys(JSON.parse(JSON.stringify(agent))).every((key) => ['allowedTools', 'id', 'modes', 'models', 'name', 'provider', 'reasoningEfforts'].includes(key)))
        }
        assert.ok(!JSON.stringify(agents).includes('systemPrompt'))
      })

      it('401 com credencial recusada em /agents, /agents/:id/tools e /tools', async () => {
        const controller = controllerWith({}, fakeCatalog(), proof)

        for (const run of [
          (res: Response) => controller.getAgents(mockRequest(), res),
          (res: Response) => controller.getAgentTools(mockRequest({ params: { agentId: 'researcher-agent' } }), res),
          (res: Response) => controller.getTools(mockRequest(), res),
        ]) {
          const { res, locals } = mockResponse()
          await withCaller(FORGED_ALICE, () => run(res))
          assert.strictEqual(locals.statusCode, 401)
        }
      })

      it('responde com credencial provada', async () => {
        const { res, locals } = mockResponse()
        await withCaller(ALICE, () => controllerWith({}, fakeCatalog(), proof).getTools(mockRequest(), res))

        assert.strictEqual(locals.statusCode, 200)
      })
    })
  })
})
