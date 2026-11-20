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
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { LiveBrowser, LiveBrowsers } from '@infra/mcp/LiveBrowser.Adapter'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { PersonBrowsers } from '@infra/mcp/PersonBrowsers.Service'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { testAgentCatalog } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'

/** 🙋 POST /sessions/:id/browser/open e /close: o navegador que a pessoa abre. Aqui sem Chromium de verdade. */
describe('AgentController — POST /sessions/:id/browser/open', () => {
  const ALICE = { token: 'good-alice', id: 'alice', email: 'alice@x.test' }
  const BOB = { token: 'good-bob', id: 'bob', email: 'bob@x.test' }
  const live: Record<string, { status: string; metadata: Record<string, unknown> }> = { a1: { status: 'idle', metadata: { owner: { id: 'alice', email: 'alice@x.test' } } } }
  const provider = {
    describe: (id: string) => {
      if (!live[id]) throw new SessionNotFoundError(id)
      return { id, ...live[id] }
    },
    list: () => [],
  } as unknown as IAgentProvider
  const conversations = new SqliteConversationRepository(':memory:')
  const desk = new LiveBrowsers()
  let launches = 0
  const personBrowsers = new PersonBrowsers({
    desk,
    resolve: () => ({ executable: '/fake', noSandbox: false, env: {} }),
    launch: async () => {
      launches += 1
      const fake = {
        person: false,
        leases: 0,
        touchedAt: 0,
        watchers: 0,
        alive: true,
        onClosed: () => undefined,
        navigate: async () => undefined,
        close: async () => undefined,
        watch: () => () => undefined,
      }
      return fake as unknown as LiveBrowser
    },
    tmp: '/tmp-fake',
    remove: () => undefined,
  })
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
    personBrowsers,
  })

  const call = async (who: typeof ALICE, route: 'browserOpen' | 'browserClose', id: string, body: unknown = {}) => {
    const out = { status: 200, body: undefined as { ok?: boolean; code?: string; result?: unknown } | undefined }
    const res = {
      status(code: number) {
        out.status = code
        return this
      },
      json(data: typeof out.body) {
        out.body = data
        return this
      },
      setHeader: () => undefined,
    } as unknown as Response
    await withCaller(who, () => controller[route]({ params: { id }, body, headers: {} } as unknown as Request, res))
    return out
  }

  it('o dono abre: { live: true }, e um segundo pedido não abre outro', async () => {
    const first = await call(ALICE, 'browserOpen', 'a1', { url: 'example.com' })
    assert.equal(first.status, 200)
    assert.deepEqual(first.body?.result, { live: true })
    await call(ALICE, 'browserOpen', 'a1', { url: 'https://b.test' })
    assert.equal(launches, 1)
  })

  it('⛔ quem não é dono recebe 404, e nada abre nem fecha', async () => {
    const before = launches
    assert.equal((await call(BOB, 'browserOpen', 'a1')).status, 404)
    assert.equal((await call(BOB, 'browserClose', 'a1')).status, 404)
    assert.equal((await call(ALICE, 'browserOpen', 'nao-existe')).status, 404)
    assert.equal(launches, before)
  })

  it('endereço bloqueado é 422 url_blocked', async () => {
    const out = await call(ALICE, 'browserOpen', 'a1', { url: 'http://169.254.169.254/' })
    assert.equal(out.status, 422)
    assert.equal(out.body?.code, 'url_blocked')
  })
})
