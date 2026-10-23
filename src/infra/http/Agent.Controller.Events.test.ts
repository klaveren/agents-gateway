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
import { withCaller } from '@infra/mcp/Caller.Identity'
import { NotifyingConversationRepository } from '@infra/persistence/Notifying.ConversationRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { Request, Response } from 'express'
import { AgentController } from './Agent.Controller'
import { ICallerProof } from './Caller.Proof'
import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'

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
    const conversations = new NotifyingConversationRepository(new SqliteConversationRepository(':memory:'), events)
    const provider = { describe: () => ({}), list: () => [] } as unknown as IAgentProvider

    const controller = new AgentController({
      agents: new AgentCatalog(AGENT_REGISTRY, new NullAgentRepository()),
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
    })

    return { controller, conversations }
  }

  /** Um `res` que guarda o que foi escrito e deixa o teste fechar a conexão. */
  const connect = async (controller: AgentController, identity: object) => {
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

    await withCaller(identity, () => controller.conversationEvents({} as Request, res))

    const events = () =>
      written
        .filter((chunk) => chunk.startsWith('id:'))
        .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)) as { type: string; session?: Record<string, unknown>; sessionId?: string })

    return { events, close: () => listeners.forEach((listener) => listener()) }
  }

  const session = (id: string, owner?: string): IConversationSession => ({
    id,
    agentId: 'researcher-agent',
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
})
