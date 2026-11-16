import assert from 'node:assert'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { SessionNotFoundError } from '@domain/errors/Domain.Error'
import { IWatch } from '@domain/models/Watch.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { testAgentCatalog } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'

/** A lista mostra o que roda em segundo plano em cada conversa: vigias, processos e outros agentes trabalhando nela. */
describe('AgentController — GET /conversations/activity', () => {
  const ALICE = { token: 'good-alice', id: 'alice', email: 'alice@x.test' }
  const mine = { owner: { id: 'alice', email: 'alice@x.test' } }
  const live: Record<string, { status: string; metadata: Record<string, unknown> }> = {
    a1: { status: 'idle', metadata: mine },
    a2: { status: 'idle', metadata: mine },
    filha1: { status: 'running', metadata: { ...mine, delegatedBy: 'a2' } },
    filha2: { status: 'running', metadata: { ...mine, delegatedBy: 'a2' } },
    filha3: { status: 'idle', metadata: { ...mine, delegatedBy: 'a2' } },
    b1: { status: 'idle', metadata: { owner: { id: 'bob' } } },
  }
  const provider = {
    describe: (id: string) => {
      if (!live[id]) throw new SessionNotFoundError(id)
      return { id, ...live[id] }
    },
    list: () => Object.entries(live).map(([id, session]) => ({ id, ...session })),
  } as unknown as IAgentProvider
  const conversations = new SqliteConversationRepository(':memory:')
  const watch = (status: IWatch['status']) => ({ status }) as IWatch
  const controller = new AgentController({
    agents: testAgentCatalog(),
    catalog: { mcpUrl: '', mcpConnected: false, mcp: { list: () => [] }, list: async () => [] } as unknown as ToolCatalog,
    createSession: new CreateSessionUseCase(provider),
    sendMessage: new SendMessageUseCase(provider, conversations),
    cancelSession: new CancelSessionUseCase(provider),
    reconfigureSession: new ReconfigureSessionUseCase(provider),
    deleteSession: new DeleteSessionUseCase(provider),
    getSession: new GetSessionUseCase(provider),
    listSessions: new ListSessionsUseCase(provider),
    proof: { prove: async (token) => token.startsWith('good-') },
    settings: new NullSettingsRepository(),
    conversations,
    watches: { list: (id) => (id === 'a1' ? [watch('active'), watch('met')] : id === 'b1' ? [watch('active')] : []), stop: () => undefined },
    processes: (id) => (id === 'a1' ? 2 : 0),
  })

  const call = async (ids: string) => {
    const out = { status: 200, body: undefined as { result?: unknown } | undefined }
    const res = {
      status(code: number) {
        out.status = code
        return this
      },
      json(data: { result?: unknown }) {
        out.body = data
        return this
      },
    } as unknown as Response
    await withCaller(ALICE, () => controller.conversationActivity({ query: { ids }, params: {}, headers: {} } as unknown as Request, res))
    return out
  }

  it('⚖️ vigias ativas, processos e agentes trabalhando por conversa; ⛔ a de outra pessoa e as paradas ficam de fora', async () => {
    const { status, body } = await call('a1,a2,b1,nao-existe,filha3')
    assert.strictEqual(status, 200)
    assert.deepStrictEqual(body?.result, {
      a1: { watches: 1, processes: 2, agents: 0 },
      a2: { watches: 0, processes: 0, agents: 2 },
    })
  })
})
