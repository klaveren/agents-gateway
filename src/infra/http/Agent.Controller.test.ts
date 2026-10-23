import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
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
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { NullConversationRepository } from '@infra/persistence/Null.ConversationRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { IAgentSettings } from '@domain/models/Settings.Model'
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
      mcpConnected: connected,
      mcp: { connectAll: async () => undefined, status: () => [{ id: 'crm', name: 'CRM', enabled: true, connected }], get: () => undefined },
      localFor: () => [],
      list: async () => [{ origin: 'local' as const, name: 'run_bash', description: '', inputSchema: {} }],
      invoke: async () => ({ status: 'success' as const, result: '' }),
    }) as unknown as ToolCatalog

  const controllerWith = (overrides: Partial<IAgentProvider> = {}, catalog = fakeCatalog(), proof?: ICallerProof, extra: Partial<IAgentControllerDeps> = {}) => {
    const provider: IAgentProvider = {
      createSession: async () => ({ id: '123', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
      sendMessage: async function* () {
        yield { type: 'message.started', sessionId: '1', timestamp: new Date() }
      },
      cancel: async () => {},
      dispose: async () => {},
      describe: () => record(),
      reconfigure: () => {
        throw new Error('not used')
      },
      list: () => [record()],
      ...overrides,
    }

    const deps: IAgentControllerDeps = {
      catalog,
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider, new NullConversationRepository()),
      cancelSession: new CancelSessionUseCase(provider),
      reconfigureSession: new ReconfigureSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      proof,
      settings: new NullSettingsRepository(),
      conversations: new NullConversationRepository(),
      ...extra,
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
      mcp: {
        connectAll: async () => {
          attempts += 1
        },
        status: () => [{ id: 'crm', name: 'CRM', enabled: true, connected: attempts > 1 }],
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
        reconfigure: () => {
          calls.push('reconfigure')
          return aliceSession
        },
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
            (res: Response) => controller.reconfigureSession(mockRequest({ params: { id: 's-alice' }, body: { model: 'x' } }), res),
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

    it('a dona troca o modelo da própria sessão; corpo vazio é 422', async () => {
      let received: unknown
      const controller = withAlice({
        reconfigure: (_id, change) => {
          received = change
          return { ...aliceSession, model: 'novo', reasoning: 'high' }
        },
      })

      const ok = mockResponse()
      await withCaller(ALICE, () => controller.reconfigureSession(mockRequest({ params: { id: 's-alice' }, body: { model: 'novo', reasoning: 'high' } }), ok.res))
      const empty = mockResponse()
      await withCaller(ALICE, () => controller.reconfigureSession(mockRequest({ params: { id: 's-alice' }, body: {} }), empty.res))

      assert.strictEqual(ok.locals.statusCode, 200)
      assert.deepStrictEqual(received, { model: 'novo', reasoning: 'high' })
      assert.strictEqual((ok.locals.body?.result as { model: string }).model, 'novo')
      assert.strictEqual(empty.locals.statusCode, 422)
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
          assert.ok(
            Object.keys(JSON.parse(JSON.stringify(agent))).every((key) =>
              ['allowedTools', 'builtIn', 'id', 'modes', 'models', 'name', 'modelReasoning', 'pricing', 'provider', 'reasoningEfforts'].includes(key),
            ),
          )
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
  /**
   * Audiência, disponibilidade, configurações e contexto da primeira mensagem.
   *
   * A prova aprova só o token `good-*`; o que está sob teste é a decisão do controller com a resposta
   * dela. A regra pura da audiência tem a matriz própria em `Settings.Model.test.ts`.
   */
  describe('operação', () => {
    const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') }
    const ADMIN = { token: 'good-admin', id: 'root', email: 'root@x.test', role: 'admin' }
    const MEMBER = { token: 'good-member', id: 'm1', email: 'm1@x.test', role: 'member' }
    const BLOCKED = { token: 'good-blocked', id: 'b1', role: 'blocked' }
    const FORGED_ADMIN = { token: 'forged-admin', id: 'root', role: 'admin' }

    afterEach(() => {
      for (const name of ['AUDIENCE_ROLES', 'DENIED_ROLES', 'ADMIN_ROLES', 'ADMIN_USERS', 'REQUIRE_PROVEN_OWNER']) delete process.env[name]
    })

    const settingsOf = (value: IAgentSettings) => ({ settings: new NullSettingsRepository(value) })

    const attempt = async (audience: IAgentSettings['audience'], identity: object | undefined, withProof: ICallerProof | null = proof) => {
      const controller = controllerWith({}, fakeCatalog(), withProof ?? undefined, settingsOf({ audience }))
      const created = mockResponse()
      const availability = mockResponse()
      const run = (work: () => Promise<void>) => (identity ? withCaller(identity, work) : work())

      await run(() => controller.createSession(mockRequest({ body: {} }), created.res))
      await run(() => controller.availability(mockRequest(), availability.res))

      return { status: created.locals.statusCode, code: created.locals.body?.code, available: (availability.locals.body?.result as { available: boolean } | undefined)?.available }
    }

    it('off recusa todos com 403 agent_unavailable, e availability diz não', async () => {
      for (const identity of [ADMIN, MEMBER]) {
        assert.deepStrictEqual(await attempt('off', identity), { status: 403, code: 'agent_unavailable', available: false })
      }
    })

    it('restricted admite só o papel da lista, provado', async () => {
      assert.deepStrictEqual(await attempt('restricted', ADMIN), { status: 201, code: undefined, available: true })
      assert.deepStrictEqual(await attempt('restricted', MEMBER), { status: 403, code: 'agent_unavailable', available: false })

      process.env.AUDIENCE_ROLES = 'member, ops'
      assert.strictEqual((await attempt('restricted', MEMBER)).status, 201)
      assert.strictEqual((await attempt('restricted', ADMIN)).status, 403)
    })

    it('restricted: token forjado com o papel certo não passa — 401 na criação, não na disponibilidade', async () => {
      assert.deepStrictEqual(await attempt('restricted', FORGED_ADMIN), { status: 401, code: 'unauthorized', available: false })
    })

    it('restricted: sem prova nem o papel certo abre, mesmo com REQUIRE_PROVEN_OWNER desligado', async () => {
      process.env.REQUIRE_PROVEN_OWNER = '0'

      assert.deepStrictEqual(await attempt('restricted', ADMIN, null), { status: 403, code: 'agent_unavailable', available: false })
    })

    it('restricted: chamada anônima não tem papel e é recusada', async () => {
      assert.strictEqual((await attempt('restricted', undefined)).status, 403)
    })

    it('all admite quem foi provado; DENIED_ROLES recusa mesmo em all', async () => {
      assert.strictEqual((await attempt('all', MEMBER)).status, 201)

      process.env.DENIED_ROLES = 'Blocked'
      assert.deepStrictEqual(await attempt('all', BLOCKED), { status: 403, code: 'agent_unavailable', available: false })
      assert.strictEqual((await attempt('all', MEMBER)).status, 201)
    })

    it('all: identidade só afirmada entra apenas com REQUIRE_PROVEN_OWNER desligado', async () => {
      assert.strictEqual((await attempt('all', MEMBER, null)).status, 401)

      process.env.REQUIRE_PROVEN_OWNER = '0'
      assert.deepStrictEqual(await attempt('all', MEMBER, null), { status: 201, code: undefined, available: true })
    })

    it('all: a chamada anônima entra (só existe com ALLOW_ANONYMOUS)', async () => {
      assert.strictEqual((await attempt('all', undefined)).status, 201)
    })

    describe('configurações', () => {
      const call = async (
        identity: object | undefined,
        run: (controller: AgentController, res: Response) => Promise<void>,
        settings = new NullSettingsRepository(),
        withProof: ICallerProof | null = proof,
      ) => {
        const { res, locals } = mockResponse()
        const controller = controllerWith({}, fakeCatalog(), withProof ?? undefined, { settings })
        await (identity ? withCaller(identity, () => run(controller, res)) : run(controller, res))

        return locals
      }

      const get = (controller: AgentController, res: Response) => controller.getSettings(mockRequest(), res)
      const put = (body: unknown) => (controller: AgentController, res: Response) => controller.updateSettings(mockRequest({ body }), res)

      it('quem não é administrador recebe 404 — papel comum, token forjado, sem prova e anônimo', async () => {
        for (const [identity, withProof] of [
          [MEMBER, proof],
          [FORGED_ADMIN, proof],
          [ADMIN, null],
          [undefined, proof],
        ] as const) {
          for (const run of [get, put({ audience: 'off' })]) {
            const settings = new NullSettingsRepository()
            const locals = await call(identity, run, settings, withProof)

            assert.strictEqual(locals.statusCode, 404)
            assert.strictEqual(locals.body?.code, 'not_found')
            assert.strictEqual((await settings.read()).audience, 'all', 'nada é gravado')
          }
        }
      })

      it('o administrador lê o gravado e o que vale quando o campo está vazio', async () => {
        const locals = await call(ADMIN, get, new NullSettingsRepository({ audience: 'restricted', model: 'm-x' }))

        assert.strictEqual(locals.statusCode, 200)
        const result = locals.body?.result as { audience: string; model: string; defaults: { agentId: string; model: string } }
        assert.strictEqual(result.audience, 'restricted')
        assert.strictEqual(result.model, 'm-x')
        assert.ok(result.defaults.agentId && result.defaults.model)
      })

      it('ADMIN_ROLES e ADMIN_USERS (id ou e-mail) também abrem a porta', async () => {
        process.env.ADMIN_ROLES = 'ops'
        assert.strictEqual((await call(ADMIN, get)).statusCode, 404, 'o padrão `admin` foi trocado')
        assert.strictEqual((await call({ ...MEMBER, role: 'OPS' }, get)).statusCode, 200)

        process.env.ADMIN_USERS = 'M1@X.test'
        assert.strictEqual((await call(MEMBER, get)).statusCode, 200)
        process.env.ADMIN_USERS = 'm1'
        assert.strictEqual((await call(MEMBER, get)).statusCode, 200)
      })

      it('PUT parcial: ausente não mexe, valor troca, null e vazio apagam, e carimba quem alterou', async () => {
        const settings = new NullSettingsRepository({ audience: 'all', agentId: 'sysops-agent', model: 'claude-opus-5' })

        const locals = await call(ADMIN, put({ audience: 'restricted' }), settings)
        assert.strictEqual(locals.statusCode, 200)
        let stored = await settings.read()
        assert.deepStrictEqual([stored.audience, stored.agentId, stored.model, stored.updatedBy], ['restricted', 'sysops-agent', 'claude-opus-5', 'root@x.test'])
        assert.ok(stored.updatedAt instanceof Date)

        await call(ADMIN, put({ model: null, agentId: '' }), settings)
        stored = await settings.read()
        assert.strictEqual('model' in stored, false)
        assert.strictEqual('agentId' in stored, false)
        assert.strictEqual(stored.audience, 'restricted')
      })

      it('PUT recusa null em campo obrigatório e agente que não existe, sem gravar', async () => {
        const settings = new NullSettingsRepository({ audience: 'restricted' })

        const required = await call(ADMIN, put({ audience: null }), settings)
        const unknown = await call(ADMIN, put({ agentId: 'ghost' }), settings)
        const badValue = await call(ADMIN, put({ audience: 'superuser' }), settings)

        for (const locals of [required, unknown, badValue]) {
          assert.strictEqual(locals.statusCode, 422)
          assert.strictEqual(locals.body?.code, 'validation_error')
        }
        assert.strictEqual((await settings.read()).audience, 'restricted')
      })

      it('a mudança vale na sessão seguinte, pelo mesmo repositório', async () => {
        const settings = new NullSettingsRepository()
        await call(ADMIN, put({ audience: 'off' }), settings)

        assert.strictEqual((await call(MEMBER, (controller, res) => controller.createSession(mockRequest({ body: {} }), res), settings)).statusCode, 403)
      })
    })

    describe('contexto da primeira mensagem', () => {
      it('entra na primeira mensagem, vem da identidade resolvida e não vai no registro do turno', async () => {
        const sent: string[] = []
        const controller = controllerWith(
          {
            describe: () => record({ turns: 0, metadata: { owner: { id: 'm1' } } }),
            reconfigure: () => {
              throw new Error('not used')
            },
            sendMessage: async function* (_id, input) {
              sent.push(input.text)
              yield { type: 'text.delta' as const, sessionId: 's', timestamp: new Date(), payload: { text: 'ok' } }
            },
          },
          fakeCatalog(),
          proof,
          { sessionContext: (identity) => `[${identity.email}]` },
        )

        const { res } = mockResponse()
        await withCaller(MEMBER, () => controller.sendMessage(mockRequest({ params: { id: 's' }, body: { message: 'oi' }, accept: 'application/json' }), res))

        assert.deepStrictEqual(sent, ['[m1@x.test]\n\noi'])
      })
    })
  })
  describe('agentes criados pela tela', () => {
    const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') }
    const ADMIN = { token: 'good-admin', id: 'root', email: 'root@x.test', role: 'admin' }
    const MEMBER = { token: 'good-member', id: 'm1', role: 'member' }

    afterEach(() => {
      delete process.env.ADMIN_ROLES
    })

    const toolsCatalog = () =>
      ({ ...fakeCatalog(), list: async () => [{ origin: 'local' as const, name: 'search_web', description: '', inputSchema: {} }] }) as unknown as ToolCatalog

    const body = {
      id: 'juridico',
      name: 'Jurídico',
      provider: 'google',
      systemPrompt: 'Você pesquisa jurisprudência.',
      models: ['gemini-3.7-flash'],
      modes: ['chat', 'agent'],
      allowedTools: ['search_web'],
    }

    const as = async (identity: object, controller: AgentController, run: (res: Response) => Promise<void>) => {
      const { res, locals } = mockResponse()
      await withCaller(identity, () => run(res))
      return locals
    }

    it('admin cria, vê com o prompt, e o agente entra na lista pública sem o prompt', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)

      const created = await as(ADMIN, controller, (res) => controller.createAgent(mockRequest({ body }), res))
      assert.strictEqual(created.statusCode, 201)
      assert.strictEqual((created.body?.result as { updatedBy: string }).updatedBy, 'root@x.test')

      const detail = await as(ADMIN, controller, (res) => controller.getAgent(mockRequest({ params: { agentId: 'juridico' } }), res))
      assert.strictEqual((detail.body?.result as { systemPrompt: string }).systemPrompt, body.systemPrompt)

      const listed = await as(MEMBER, controller, (res) => controller.getAgents(mockRequest(), res))
      const juridico = (listed.body?.result as Array<Record<string, unknown>>).find((agent) => agent.id === 'juridico')
      assert.strictEqual(juridico?.builtIn, false)
      assert.strictEqual('systemPrompt' in (juridico ?? {}), false)
    })

    it('⛔ quem não é admin recebe 404 em criar, ler, editar e apagar', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)
      const params = { agentId: 'juridico' }

      for (const run of [
        (res: Response) => controller.createAgent(mockRequest({ body }), res),
        (res: Response) => controller.getAgent(mockRequest({ params }), res),
        (res: Response) => controller.updateAgent(mockRequest({ params, body }), res),
        (res: Response) => controller.deleteAgent(mockRequest({ params }), res),
      ]) {
        assert.strictEqual((await as(MEMBER, controller, run)).statusCode, 404)
      }
    })

    it('agente inválido: 422 com todos os problemas em details', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)

      const out = await as(ADMIN, controller, (res) => controller.createAgent(mockRequest({ body: { ...body, models: ['gpt-5.6-sol'], allowedTools: ['run_bash'] } }), res))

      assert.strictEqual(out.statusCode, 422)
      assert.deepStrictEqual(
        (out.body as unknown as { details: Array<{ field: string }> }).details.map((issue) => issue.field),
        ['models', 'allowedTools'],
      )
    })

    it('⛔ prompt com chave que o ADK lê como variável é recusado para Google', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)

      const out = await as(ADMIN, controller, (res) => controller.createAgent(mockRequest({ body: { ...body, systemPrompt: 'Olá {user}' } }), res))

      assert.strictEqual(out.statusCode, 422)
    })

    it('embutido é só leitura: 409 agent_read_only', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)

      const out = await as(ADMIN, controller, (res) => controller.deleteAgent(mockRequest({ params: { agentId: 'researcher-agent' } }), res))

      assert.strictEqual(out.statusCode, 409)
      assert.strictEqual(out.body?.code, 'agent_read_only')
    })

    it('editar troca o agente criado; apagar tira da lista', async () => {
      const controller = controllerWith({}, toolsCatalog(), proof)
      const params = { agentId: 'juridico' }
      await as(ADMIN, controller, (res) => controller.createAgent(mockRequest({ body }), res))

      const updated = await as(ADMIN, controller, (res) => controller.updateAgent(mockRequest({ params, body: { ...body, id: 'ignorado', name: 'Jurídico 2' } }), res))
      assert.strictEqual((updated.body?.result as { id: string; name: string }).name, 'Jurídico 2')
      assert.strictEqual((updated.body?.result as { id: string }).id, 'juridico')

      assert.strictEqual((await as(ADMIN, controller, (res) => controller.deleteAgent(mockRequest({ params }), res))).statusCode, 200)
      assert.strictEqual((await as(ADMIN, controller, (res) => controller.getAgent(mockRequest({ params }), res))).statusCode, 404)
    })
  })
})
