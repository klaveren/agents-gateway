import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { Request, Response } from 'express'
import { AgentCatalog } from '@application/Agent.Catalog'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentUnavailableError, SessionBusyError } from '@domain/errors/Domain.Error'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { GOOGLE_TEST_AGENT, TEST_AGENTS } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'
import { HttpError } from './Http.Error'
import { useProjectAccess } from './Project.Access'

/** ⚖️ O turno que nem começou: 409/422/429 (e o 403 de agente indisponível) ao iniciar ficam em `GET /errors?kind=refused`, com o recorte por projeto e a máscara. */
describe('AgentController: o início de turno recusado vai para o registro de erros', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ROOT = token('u_root', 'admin')
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin' }, beta: { u_bia: 'admin' } }

  const agentsRepository = new NullAgentRepository()
  agentsRepository.seedOnce([...TEST_AGENTS, { ...GOOGLE_TEST_AGENT, id: 'agente-alfa', name: 'Agente alfa', projectId: 'alfa' }], 'teste')
  const agents = new AgentCatalog(agentsRepository)

  before(() =>
    useProjectAccess({
      roles: {
        exists: (id) => id in members,
        roleOf: (id, userId) => (userId ? members[id]?.[userId] : undefined),
        projectsOf: (userId) => Object.keys(members).filter((id) => members[id]![userId]),
      },
      agentProject: (agentId) => agents.get(agentId)?.projectId ?? (agents.get(agentId) ? null : undefined),
    }),
  )
  after(() => useProjectAccess(undefined))

  const conversations = new SqliteConversationRepository(':memory:')
  let createFailure: Error = new AgentUnavailableError()
  const provider = {
    createSession: async () => {
      throw createFailure
    },
    // eslint-disable-next-line require-yield
    sendMessage: async function* () {
      throw new SessionBusyError('c-alfa')
    },
    describe: () => ({
      id: 'c-alfa',
      agentId: 'agente-alfa',
      provider: EProvider.GOOGLE,
      mode: EMode.CHAT,
      model: 'gemini-3.7-flash',
      tools: false,
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      status: 'idle',
      turns: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      metadata: { owner: { id: 'u_ana', email: 'u_ana@x.test' }, project: 'alfa' },
    }),
    list: () => [],
  } as unknown as IAgentProvider
  const projects = {
    exists: (id: string) => id in members,
    get: (id: string) => ({ id, name: id }),
    canUse: (caller: { userId?: string }, id: string) => !!caller.userId && !!members[id]?.[caller.userId],
  }
  const controller = new AgentController({
    agents,
    catalog: { mcpUrl: '', mcpConnected: false, mcp: { list: () => [] }, list: async () => [] } as unknown as ToolCatalog,
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
    projects: projects as never,
  })

  type THandler = 'createSession' | 'sendMessage' | 'listErrors'
  const call = (
    as: string,
    handler: THandler,
    input: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; code?: string; message?: string; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = {
        status(code: number) {
          reply.status = code
          return this
        },
        json(payload: typeof reply.body) {
          reply.body = payload
          return this
        },
      } as unknown as Response
      const req = { params: input.params ?? {}, body: input.body ?? {}, query: input.query ?? {}, headers: input.headers ?? {}, accepts: () => 'application/json' }
      await controller[handler](req as unknown as Request, res)
      return reply
    })
  const refused = async (as: string) => (await call(as, 'listErrors', { query: { kind: 'refused' } })).body!.result

  it('sessão ocupada (409) e agente indisponível (403) aparecem em /errors?kind=refused, sem mudar a resposta', async () => {
    const busy = await call(ANA, 'sendMessage', { params: { id: 'c-alfa' }, body: { message: 'oi' }, headers: { 'x-gateway-origin': 'hook' } })
    assert.strictEqual(busy.status, 409)
    const unavailable = await call(ANA, 'createSession', { body: { agentId: 'agente-alfa' } })
    assert.strictEqual(unavailable.status, 403)

    const log = await refused(ANA)
    assert.strictEqual(log.byKind.refused, 2)
    const byStatus = Object.fromEntries(log.items.map((item: { status: number }) => [item.status, item]))
    assert.deepStrictEqual([byStatus[409].kind, byStatus[409].conversationId, byStatus[409].agentId, byStatus[409].origin], ['refused', 'c-alfa', 'agente-alfa', 'hook'])
    assert.strictEqual(byStatus[409].message, busy.body!.message)
    assert.deepStrictEqual([byStatus[403].conversationId, byStatus[403].origin], [undefined, 'api'])
    // Os filtros de sempre: o tipo e o agente.
    assert.strictEqual((await call(ANA, 'listErrors', { query: { kind: 'turn' } })).body!.result.items.length, 0)
    assert.strictEqual((await call(ANA, 'listErrors', { query: { agentId: 'outro' } })).body!.result.items.length, 0)
  })

  it('o admin de outro projeto não vê; a recusa sem projeto é só do admin do gateway', async () => {
    assert.strictEqual((await refused(BIA)).items.length, 0)
    assert.strictEqual((await refused(BIA)).byKind.refused, 0)
    // As duas de cima são do `alfa`: o admin do gateway (sem papel de projeto) não as vê.
    assert.strictEqual((await refused(ROOT)).items.length, 0)
    const global = await call(ROOT, 'createSession', { body: { agentId: 'pesquisa-teste' } })
    assert.strictEqual(global.status, 403)
    assert.strictEqual((await refused(ROOT)).items.length, 1)
    assert.strictEqual((await refused(ANA)).items.length, 2)
  })

  it('a mensagem passa pela máscara de segredos antes de gravar', async () => {
    createFailure = new HttpError(422, 'validation_error', 'chave ghp_abcdefghijklmnopqrstuvwxyz0123456789AB recusada')
    const reply = await call(ANA, 'createSession', { body: { agentId: 'agente-alfa' } })
    assert.strictEqual(reply.status, 422)
    const stored = (await refused(ANA)).items.find((item: { code: string }) => item.code === 'validation_error')
    assert.ok(stored)
    assert.ok(!stored.message.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'), stored.message)
    assert.ok(stored.message.includes('[segredo:'))
  })
})
