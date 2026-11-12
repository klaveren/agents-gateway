import assert from 'node:assert'
import { afterEach, describe, it, mock } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { IConversationSession } from '@domain/models/Conversation.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { InMemoryCatalogEvents } from '@infra/events/InMemory.CatalogEvents'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { TurnLive } from '@infra/events/Turn.Live'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { Request, Response } from 'express'
import { AgentController, STREAM_RECHECK_MS } from './Agent.Controller'
import { ICallerProof } from './Caller.Proof'
import { useProjectAccess } from './Project.Access'
import { testAgentCatalog } from '../../testing/Agents.Fixture'

/** `GET /conversations/events`: o que cada chamador recebe ao vivo, contra o SQLite de verdade. */
describe('AgentController — eventos das conversas (SSE)', () => {
  /** As credenciais que deixaram de valer no meio do teste (a pessoa saiu, a conta foi desativada). */
  const revoked = new Set<string>()
  const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') && !revoked.has(token) }
  const ALICE = { token: 'good-alice', id: 'alice', email: 'alice@x.test' }
  const ADMIN = { token: 'good-root', id: 'root', role: 'admin' }

  afterEach(() => {
    delete process.env.ADMIN_ROLES
    delete process.env.STREAMS_PER_OWNER
    revoked.clear()
    useProjectAccess(undefined)
    mock.timers.reset()
  })

  /** `slow.describe`: enquanto não resolver, a leitura da sessão viva fica esperando (o meio de uma conferência de acesso). */
  const build = (projects?: { canUse: (caller: { userId?: string; admin: boolean }, projectId: string) => boolean }, slow: { describe?: Promise<void> } = {}) => {
    const events = new InMemoryConversationEvents()
    const catalogEvents = new InMemoryCatalogEvents()
    const live = new TurnLive(events)
    const conversations = new NotifyingConversationRepository(new SqliteConversationRepository(':memory:'), events)
    // A sessão viva `viva-alice` é da Alice; as outras só existem no banco (ou em lugar nenhum).
    const provider = {
      describe: (id: string) => {
        const found = () => {
          if (id !== 'viva-alice') throw new Error('Session not found')
          return { id, metadata: { owner: { id: 'alice' } } }
        }
        return slow.describe ? slow.describe.then(found) : found()
      },
      list: () => [],
    } as unknown as IAgentProvider

    // As assinaturas abertas nos três barramentos: o que sobra depois de um stream fechar é vazamento.
    const open = { subscriptions: 0 }
    const counting =
      <A extends unknown[]>(subscribe: (...args: A) => () => void) =>
      (...args: A) => {
        open.subscriptions++
        const unsubscribe = subscribe(...args)
        return () => {
          open.subscriptions--
          unsubscribe()
        }
      }
    events.subscribe = counting(events.subscribe.bind(events))
    catalogEvents.subscribe = counting(catalogEvents.subscribe.bind(catalogEvents))
    live.subscribe = counting(live.subscribe.bind(live))

    const controller = new AgentController({
      agents: testAgentCatalog(),
      catalog: { mcpUrl: '', mcpConnected: false, list: async () => [] } as unknown as ToolCatalog,
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider, conversations),
      cancelSession: new CancelSessionUseCase(provider),
      reconfigureSession: new ReconfigureSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      proof,
      settings: new NullSettingsRepository(),
      conversations,
      events,
      catalogEvents,
      live,
      ...(projects ? { projects: projects as never } : {}),
    })

    const baseline = open.subscriptions

    return { controller, conversations, live, catalogEvents, subscriptions: () => open.subscriptions - baseline }
  }

  /**
   * Um `res` que guarda o que foi escrito e deixa o teste fechar a conexão. `gone`: quem pediu já desistiu (a conexão
   * fechou enquanto a credencial era conferida).
   */
  const connect = async (
    controller: AgentController,
    identity: object,
    route: (req: Request, res: Response) => Promise<unknown> = controller.conversationEvents,
    req = {} as Request,
    gone = false,
  ) => {
    const written: string[] = []
    const listeners: Array<() => void> = []
    let ends = 0
    const res = {
      destroyed: gone,
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => written.push(chunk),
      end: () => ends++,
      on: (event: string, listener: () => void) => {
        if (event === 'close') listeners.push(listener)
      },
      status() {
        return this
      },
      json: () => undefined,
    } as unknown as Response

    await withCaller(identity, () => route(req, res))

    const events = () =>
      written
        .filter((chunk) => chunk.startsWith('id:') && !chunk.includes('event: stream.ready'))
        .map(
          (chunk) =>
            JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)) as {
              type: string
              session?: Record<string, unknown>
              sessionId?: string
              turn?: { request: string; events: unknown[] }
              event?: { type: string }
            },
        )

    const ready = written.find((chunk) => chunk.includes('event: stream.ready'))
    const streamId = ready ? (JSON.parse(ready.slice(ready.indexOf('data: ') + 6)) as { streamId: string }).streamId : undefined

    return { events, written, streamId, ends: () => ends, close: () => listeners.forEach((listener) => listener()) }
  }

  /** `PUT /conversations/events/:streamId/follow` como `identity`: o status da resposta. */
  const follow = async (controller: AgentController, identity: object, streamId: string | undefined, sessionId: string | null) => {
    const reply = { status: 200 }
    const res = {
      status(code: number) {
        reply.status = code
        return this
      },
      json: () => undefined,
    } as unknown as Response
    await withCaller(identity, () => controller.followTurn({ params: { streamId }, body: { sessionId } } as unknown as Request, res))
    return reply.status
  }

  /** Passa o tempo de UMA conferência dos streams abertos (`guardStream`) e espera ela terminar. */
  const recheck = async () => {
    mock.timers.tick(STREAM_RECHECK_MS)
    await new Promise((resolve) => setImmediate(resolve))
  }

  const session = (id: string, owner?: string, project?: string): IConversationSession => ({
    id,
    agentId: 'pesquisa-teste',
    provider: 'google',
    mode: EMode.CHAT,
    model: 'gemini-3.7-flash',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    turns: 1,
    usage: {},
    metadata: owner ? { owner: { id: owner }, ...(project ? { project } : {}) } : undefined,
  })

  const talk = async (repo: NotifyingConversationRepository, id: string, owner?: string, project?: string) => {
    await repo.saveSession(session(id, owner, project))
    await repo.appendTurn({ sessionId: id, index: 0, at: new Date('2026-09-01T10:01:00Z'), request: 'oi', text: 'olá', toolCalls: [] })
  }

  it('catálogo mudou: só o global e os projetos de que a pessoa é membro (nem o admin do gateway entra); fechar para de avisar', async () => {
    // ⛔ `canUse` é só membro: o passe do admin acabou (ver `Project.Access`).
    const { controller, catalogEvents } = build({ canUse: (caller, projectId) => caller.userId === 'alice' && projectId === 'alfa' })
    process.env.ADMIN_ROLES = 'admin'
    const admin = await connect(controller, ADMIN)
    const alice = await connect(controller, ALICE)
    catalogEvents.publish([
      { kind: 'spec', id: 'arq', projectId: 'alfa', op: 'update' },
      { kind: 'spec', id: 'segredo', projectId: 'beta', op: 'create' },
      { kind: 'agent', id: 'atlas', op: 'update' },
    ])
    const changes = (events: ReturnType<typeof admin.events>) =>
      events.filter((event) => event.type === 'catalog.changed').map((event) => (event as unknown as { changes: Array<{ id: string }> }).changes.map((one) => one.id))
    assert.deepStrictEqual(changes(admin.events()), [['atlas']])
    assert.deepStrictEqual(changes(alice.events()), [['arq', 'atlas']])
    alice.close()
    catalogEvents.publish([{ kind: 'rule', id: 'r1', op: 'create' }])
    assert.deepStrictEqual(changes(alice.events()), [['arq', 'atlas']])
    // Nada visível: nada sai.
    catalogEvents.publish([{ kind: 'spec', id: 'outra', projectId: 'beta', op: 'update' }])
    assert.strictEqual(changes(admin.events()).length, 2)
  })

  it('quem não é admin só recebe as próprias conversas, e sem rótulo', async () => {
    const { controller, conversations } = build()
    const alice = await connect(controller, ALICE)

    await talk(conversations, 'a1', 'alice')
    await talk(conversations, 'b1', 'bob')
    await conversations.classifyTurn('a1', 0, 'red')

    const received = alice.events()
    assert.deepStrictEqual(
      received.map((event) => event.session?.id),
      ['a1', 'a1'],
    )
    assert.ok(received.every((event) => !('classification' in (event.session ?? {}))))
    assert.deepStrictEqual(received[0].session?.preview, { at: '2026-09-01T10:01:00.000Z', request: 'oi', text: 'olá' })
  })

  it('o admin recebe todas, com o rótulo, e o apagar de qualquer uma', async () => {
    process.env.ADMIN_ROLES = 'admin'
    const { controller, conversations } = build()
    const admin = await connect(controller, ADMIN)

    await talk(conversations, 'b1', 'bob')
    await conversations.classifyTurn('b1', 0, 'green')
    await conversations.deleteSession('b1')

    const received = admin.events()
    assert.deepStrictEqual(
      received.map((event) => event.type),
      ['conversation.updated', 'conversation.updated', 'conversation.deleted'],
    )
    assert.strictEqual(received[1].session?.classification, 'green')
    assert.strictEqual(received[2].sessionId, 'b1')
  })

  it('fechar a conexão cancela a assinatura', async () => {
    const { controller, conversations } = build()
    const alice = await connect(controller, ALICE)

    alice.close()
    await talk(conversations, 'a1', 'alice')

    assert.deepStrictEqual(alice.events(), [])
  })

  it('credencial que não passa na prova: 401, e nada fica assinado', async () => {
    const { controller } = build()
    const out = { status: 0 }
    const res = {
      status(code: number) {
        out.status = code
        return this
      },
      json: () => undefined,
    } as unknown as Response

    await withCaller({ token: 'forged-alice', id: 'alice' }, () => controller.conversationEvents({} as Request, res))

    assert.strictEqual(out.status, 401)
  })

  it('o turno rodando: a lista avisa running e idle, e quem conecta no meio já sabe', async () => {
    const { controller, live } = build()
    const ticket = live.start('viva-alice', 'oi', { owner: { id: 'alice' } })
    live.start('viva-bob', 'oi', { owner: { id: 'bob' } })
    const alice = await connect(controller, ALICE)

    live.finish('viva-alice', ticket)

    assert.deepStrictEqual(
      alice.events().map((event) => [event.type, event.sessionId]),
      [
        ['conversation.running', 'viva-alice'],
        ['conversation.idle', 'viva-alice'],
      ],
    )
  })

  it('/live: o dono recebe o retrato do turno em curso, os eventos e o fim; os outros, 404', async () => {
    const { controller, live } = build()
    const route = controller.sessionLive
    const req = { params: { id: 'viva-alice' } } as unknown as Request
    const ticket = live.start('viva-alice', 'faça o build', { owner: { id: 'alice' } })
    live.push('viva-alice', { type: 'text.delta', sessionId: 'viva-alice', payload: { text: 'rodando' }, timestamp: new Date() })

    const alice = await connect(controller, ALICE, route, req)
    live.push('viva-alice', { type: 'tool.started', sessionId: 'viva-alice', payload: { tool: 'run_bash', args: {} }, timestamp: new Date() })
    live.finish('viva-alice', ticket)

    const received = alice.events()
    assert.deepStrictEqual(
      received.map((event) => event.type),
      ['turn.started', 'turn.event', 'turn.finished'],
    )
    assert.strictEqual(received[0].turn?.request, 'faça o build')
    assert.strictEqual(received[0].turn?.events.length, 1)
    assert.strictEqual(received[1].event?.type, 'tool.started')

    const out = { status: 0 }
    const res = {
      status(code: number) {
        out.status = code
        return this
      },
      json: () => undefined,
    } as unknown as Response
    await withCaller({ token: 'good-bob', id: 'bob' }, () => controller.sessionLive(req, res))
    assert.strictEqual(out.status, 404)
    await withCaller(ALICE, () => controller.sessionLive({ params: { id: 'nao-existe' } } as unknown as Request, res))
    assert.strictEqual(out.status, 404)
  })

  it('acompanhar pela caixa de entrada: o turno da conversa aberta vem no MESMO stream; o de outro, nunca', async () => {
    const { controller, live } = build()
    const alice = await connect(controller, ALICE)

    // Sem turno rodando: avisa `turn.idle` (quem reconecta descobre que o turno que via acabou).
    assert.strictEqual(await follow(controller, ALICE, alice.streamId, 'viva-alice'), 200)
    const ticket = live.start('viva-alice', 'oi', { owner: { id: 'alice' } })
    live.finish('viva-alice', ticket)
    assert.deepStrictEqual(
      alice
        .events()
        .filter((event) => event.type.startsWith('turn.'))
        .map((event) => [event.type, event.sessionId]),
      [
        ['turn.idle', 'viva-alice'],
        ['turn.started', 'viva-alice'],
        ['turn.finished', 'viva-alice'],
      ],
    )

    // Parar de acompanhar: nada mais chega.
    await follow(controller, ALICE, alice.streamId, null)
    live.start('viva-alice', 'de novo', { owner: { id: 'alice' } })
    assert.strictEqual(alice.events().filter((event) => event.type === 'turn.started').length, 1)

    // O stream de outro, ou a conversa de outro: 404.
    assert.strictEqual(await follow(controller, { token: 'good-bob', id: 'bob' }, alice.streamId, 'viva-alice'), 404)
    assert.strictEqual(await follow(controller, ALICE, alice.streamId, 'viva-bob'), 404)
  })

  describe('o stream aberto é conferido de novo (guardStream)', () => {
    const turns = (stream: { events: () => Array<{ type: string; sessionId?: string }> }) =>
      stream
        .events()
        .filter((event) => event.type.startsWith('turn.'))
        .map((event) => [event.type, event.sessionId])

    it('a credencial deixa de valer com o stream aberto: a conferência FECHA o stream, nada fica assinado e a vaga volta', async () => {
      process.env.STREAMS_PER_OWNER = '1'
      mock.timers.enable({ apis: ['setInterval'] })
      const { controller, conversations, subscriptions } = build()
      const alice = await connect(controller, ALICE)
      assert.strictEqual(await follow(controller, ALICE, alice.streamId, 'viva-alice'), 200)
      // A vaga única está ocupada.
      assert.strictEqual((await connect(controller, ALICE)).streamId, undefined)

      // Ainda vale: a conferência passa e o stream segue.
      await recheck()
      await talk(conversations, 'a1', 'alice')
      assert.strictEqual(alice.ends(), 0)
      assert.strictEqual(alice.events().filter((event) => event.type === 'conversation.updated').length, 1)
      assert.strictEqual(subscriptions(), 3)

      revoked.add(ALICE.token)
      await recheck()
      assert.strictEqual(alice.ends(), 1)
      assert.strictEqual(subscriptions(), 0)
      // A conexão fechando depois não solta a vaga duas vezes.
      alice.close()
      assert.strictEqual(alice.ends(), 1)
      assert.strictEqual(subscriptions(), 0)

      // O stream já não existe para o `follow`, e a vaga voltou para a conta (com uma credencial que vale).
      const again = { ...ALICE, token: 'good-alice-de-novo' }
      assert.strictEqual(await follow(controller, again, alice.streamId, 'viva-alice'), 404)
      const next = await connect(controller, again)
      assert.ok(next.streamId)
      assert.strictEqual((await connect(controller, again)).streamId, undefined)
    })

    it('saiu do projeto com o stream aberto: o catálogo dele para de chegar; o stream só daquele projeto fecha', async () => {
      mock.timers.enable({ apis: ['setInterval'] })
      const member = new Set(['alfa'])
      const { controller, catalogEvents } = build({ canUse: (caller, projectId) => caller.userId === 'alice' && member.has(projectId) })
      const inbox = await connect(controller, ALICE)
      const scoped = await connect(controller, ALICE, controller.conversationEvents, { query: { project: 'alfa' } } as unknown as Request)
      const changes = (stream: typeof inbox) => stream.events().filter((event) => event.type === 'catalog.changed').length

      catalogEvents.publish([{ kind: 'spec', id: 'arq', projectId: 'alfa', op: 'update' }])
      assert.deepStrictEqual([changes(inbox), changes(scoped)], [1, 1])

      member.delete('alfa')
      await recheck()
      catalogEvents.publish([{ kind: 'spec', id: 'arq', projectId: 'alfa', op: 'update' }])
      assert.deepStrictEqual([changes(inbox), changes(scoped)], [1, 1])
      assert.deepStrictEqual([inbox.ends(), scoped.ends()], [0, 1])
    })

    it('admin de projeto rebaixado com o stream aberto: deixa de receber as conversas dos outros', async () => {
      mock.timers.enable({ apis: ['setInterval'] })
      const admin = new Set(['alfa'])
      useProjectAccess({ roles: { exists: () => true, roleOf: (projectId) => (admin.has(projectId) ? 'admin' : 'member'), projectsOf: () => ['alfa'] } })
      const { controller, conversations } = build({ canUse: () => true })
      const alice = await connect(controller, ALICE)
      const seen = () => alice.events().map((event) => event.session?.id)

      await talk(conversations, 'b1', 'bob', 'alfa')
      assert.deepStrictEqual(seen(), ['b1'])

      admin.delete('alfa')
      await recheck()
      await talk(conversations, 'b2', 'bob', 'alfa')
      await talk(conversations, 'a1', 'alice', 'alfa')
      assert.deepStrictEqual(seen(), ['b1', 'a1'])
      assert.strictEqual(alice.ends(), 0)
    })

    it('a conversa acompanhada deixou de ser dele: para de acompanhar, e o stream segue', async () => {
      mock.timers.enable({ apis: ['setInterval'] })
      const member = new Set(['alfa'])
      const { controller, conversations, live, subscriptions } = build({ canUse: (_caller, projectId) => member.has(projectId) })
      await talk(conversations, 'p1', 'alice', 'alfa')
      const alice = await connect(controller, ALICE)
      assert.strictEqual(await follow(controller, ALICE, alice.streamId, 'p1'), 200)
      assert.strictEqual(subscriptions(), 3)

      member.delete('alfa')
      await recheck()
      live.start('p1', 'oi', { owner: { id: 'alice' }, project: 'alfa' })
      assert.deepStrictEqual(turns(alice), [['turn.idle', 'p1']])
      assert.strictEqual(subscriptions(), 2)
      assert.strictEqual(alice.ends(), 0)
    })

    it('/live: a credencial deixa de valer com o stream aberto e ele fecha', async () => {
      mock.timers.enable({ apis: ['setInterval'] })
      const { controller, live, subscriptions } = build()
      const alice = await connect(controller, ALICE, controller.sessionLive, { params: { id: 'viva-alice' } } as unknown as Request)

      await recheck()
      assert.deepStrictEqual([alice.ends(), subscriptions()], [0, 1])

      revoked.add(ALICE.token)
      await recheck()
      assert.deepStrictEqual([alice.ends(), subscriptions()], [1, 0])
      live.start('viva-alice', 'oi', { owner: { id: 'alice' } })
      assert.deepStrictEqual(alice.events(), [])
    })

    it('quem desistiu antes do stream abrir não segura vaga nem assinatura', async () => {
      process.env.STREAMS_PER_OWNER = '1'
      const { controller, subscriptions } = build()

      const inbox = await connect(controller, ALICE, controller.conversationEvents, {} as Request, true)
      const live = await connect(controller, ALICE, controller.sessionLive, { params: { id: 'viva-alice' } } as unknown as Request, true)
      assert.deepStrictEqual([inbox.written, live.written], [[], []])
      assert.strictEqual(subscriptions(), 0)

      // A vaga única continua livre.
      assert.ok((await connect(controller, ALICE)).streamId)
    })

    it('acompanhar: o stream fechou enquanto o acesso era conferido → 404, e nenhuma assinatura fica órfã', async () => {
      const slow: { describe?: Promise<void> } = {}
      const { controller, subscriptions } = build(undefined, slow)
      const alice = await connect(controller, ALICE)
      let answer = () => {}
      slow.describe = new Promise<void>((resolve) => (answer = resolve))

      const pending = follow(controller, ALICE, alice.streamId, 'viva-alice')
      await new Promise((resolve) => setImmediate(resolve))
      alice.close()
      answer()

      assert.strictEqual(await pending, 404)
      assert.strictEqual(subscriptions(), 0)
    })

    it('acompanhar: dois pedidos em corrida — vale o último que chega, com UMA assinatura só', async () => {
      const slow: { describe?: Promise<void> } = {}
      const { controller, conversations, live, subscriptions } = build(undefined, slow)
      await talk(conversations, 'a1', 'alice')
      const alice = await connect(controller, ALICE)
      let answer = () => {}
      slow.describe = new Promise<void>((resolve) => (answer = resolve))

      // O primeiro fica esperando a conferência; o segundo passa na frente e começa a acompanhar.
      const first = follow(controller, ALICE, alice.streamId, 'viva-alice')
      await new Promise((resolve) => setImmediate(resolve))
      slow.describe = undefined
      assert.strictEqual(await follow(controller, ALICE, alice.streamId, 'a1'), 200)
      answer()
      assert.strictEqual(await first, 200)

      assert.strictEqual(subscriptions(), 3)
      live.start('a1', 'oi', { owner: { id: 'alice' } })
      live.start('viva-alice', 'oi', { owner: { id: 'alice' } })
      assert.deepStrictEqual(turns(alice), [
        ['turn.idle', 'a1'],
        ['turn.idle', 'viva-alice'],
        ['turn.started', 'viva-alice'],
      ])

      alice.close()
      assert.strictEqual(subscriptions(), 0)
    })
  })
})
