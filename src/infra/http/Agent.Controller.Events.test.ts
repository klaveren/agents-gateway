import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
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
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { TurnLive } from '@infra/events/Turn.Live'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { Request, Response } from 'express'
import { AgentController } from './Agent.Controller'
import { ICallerProof } from './Caller.Proof'
import { testAgentCatalog } from '../../testing/Agents.Fixture'

/** `GET /conversations/events`: o que cada chamador recebe ao vivo, contra o SQLite de verdade. */
describe('AgentController — eventos das conversas (SSE)', () => {
  const proof: ICallerProof = { prove: async (token) => token.startsWith('good-') }
  const ALICE = { token: 'good-alice', id: 'alice', email: 'alice@x.test' }
  const ADMIN = { token: 'good-root', id: 'root', role: 'admin' }

  afterEach(() => {
    delete process.env.ADMIN_ROLES
  })

  const build = () => {
    const events = new InMemoryConversationEvents()
    const live = new TurnLive(events)
    const conversations = new NotifyingConversationRepository(new SqliteConversationRepository(':memory:'), events)
    // A sessão viva `viva-alice` é da Alice; as outras só existem no banco (ou em lugar nenhum).
    const provider = {
      describe: (id: string) => {
        if (id !== 'viva-alice') throw new Error('Session not found')
        return { id, metadata: { owner: { id: 'alice' } } }
      },
      list: () => [],
    } as unknown as IAgentProvider

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
      live,
    })

    return { controller, conversations, live }
  }

  /** Um `res` que guarda o que foi escrito e deixa o teste fechar a conexão. */
  const connect = async (
    controller: AgentController,
    identity: object,
    route: (req: Request, res: Response) => Promise<unknown> = controller.conversationEvents,
    req = {} as Request,
  ) => {
    const written: string[] = []
    const listeners: Array<() => void> = []
    const res = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk: string) => written.push(chunk),
      end: () => undefined,
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

    return { events, written, streamId, close: () => listeners.forEach((listener) => listener()) }
  }

  const session = (id: string, owner?: string): IConversationSession => ({
    id,
    agentId: 'pesquisa-teste',
    provider: 'google',
    mode: EMode.CHAT,
    model: 'gemini-3.7-flash',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    turns: 1,
    usage: {},
    metadata: owner ? { owner: { id: owner } } : undefined,
  })

  const talk = async (repo: NotifyingConversationRepository, id: string, owner?: string) => {
    await repo.saveSession(session(id, owner))
    await repo.appendTurn({ sessionId: id, index: 0, at: new Date('2026-09-01T10:01:00Z'), request: 'oi', text: 'olá', toolCalls: [] })
  }

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
    const reply = { status: 200, body: undefined as unknown }
    const res = {
      status(code: number) {
        reply.status = code
        return this
      },
      json: (body: unknown) => (reply.body = body),
    } as unknown as Response
    const follow = (identity: object, streamId: string | undefined, sessionId: string | null) =>
      withCaller(identity, () => controller.followTurn({ params: { streamId }, body: { sessionId } } as unknown as Request, res))

    // Sem turno rodando: avisa `turn.idle` (quem reconecta descobre que o turno que via acabou).
    await follow(ALICE, alice.streamId, 'viva-alice')
    assert.strictEqual(reply.status, 200)
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
    await follow(ALICE, alice.streamId, null)
    live.start('viva-alice', 'de novo', { owner: { id: 'alice' } })
    assert.strictEqual(alice.events().filter((event) => event.type === 'turn.started').length, 1)

    // O stream de outro, ou a conversa de outro: 404.
    await follow({ token: 'good-bob', id: 'bob' }, alice.streamId, 'viva-alice')
    assert.strictEqual(reply.status, 404)
    await follow(ALICE, alice.streamId, 'viva-bob')
    assert.strictEqual(reply.status, 404)
  })
})
