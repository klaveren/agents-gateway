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
import { IConversationSession } from '@domain/models/Conversation.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { identityFromToken, withCaller } from '@infra/mcp/Caller.Identity'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { GOOGLE_TEST_AGENT, TEST_AGENTS } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'
import { useProjectAccess } from './Project.Access'

/**
 * ⛔ O isolamento por projeto (ver `Project.Access`): a Ana administra `alfa`, a Bia administra `beta`, o Caio é membro
 * de `alfa`, o root administra o gateway e não é membro de projeto nenhum.
 */
describe('AgentController: o admin do projeto, só o projeto dele', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ROOT = token('u_root', 'admin')
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')
  const CAIO = token('u_caio', 'member')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = { alfa: { u_ana: 'admin', u_caio: 'member' }, beta: { u_bia: 'admin' } }

  const agentsRepository = new NullAgentRepository()
  agentsRepository.seedOnce(
    [
      ...TEST_AGENTS,
      { ...GOOGLE_TEST_AGENT, id: 'agente-alfa', name: 'Agente alfa', projectId: 'alfa' },
      { ...GOOGLE_TEST_AGENT, id: 'agente-beta', name: 'Agente beta', projectId: 'beta' },
      { ...GOOGLE_TEST_AGENT, id: 'agente-alfa-admin', name: 'Agente alfa só de admin', projectId: 'alfa', adminOnly: true },
    ],
    'teste',
  )
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
  const provider = {
    createSession: async () => ({ id: 'novo', provider: EProvider.GOOGLE, mode: EMode.CHAT, createdAt: new Date() }),
    describe: () => {
      throw new Error('Session not found')
    },
    list: () => [],
  } as unknown as IAgentProvider
  const projects = {
    exists: (id: string) => id in members,
    get: (id: string) => ({ id, name: id }),
    canUse: (caller: { userId?: string }, id: string) => !!caller.userId && !!members[id]?.[caller.userId],
  }
  const controller = new AgentController({
    agents,
    catalog: {
      mcpUrl: '',
      mcpConnected: false,
      mcp: { list: () => [] },
      list: async () => [{ origin: 'local', name: 'search_web', description: '', inputSchema: {} }],
    } as unknown as ToolCatalog,
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

  const session = (id: string, owner: string, project?: string): IConversationSession => ({
    id,
    agentId: 'pesquisa-teste',
    provider: 'google',
    mode: 'chat',
    model: 'gemini-3.7-flash',
    title: `Conversa ${id}`,
    turns: 1,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    metadata: { owner: { id: owner }, ...(project ? { project } : {}) },
  })
  before(async () => {
    await conversations.saveSession(session('c-alfa', 'u_caio', 'alfa'))
    await conversations.saveSession(session('c-beta', 'u_bia', 'beta'))
    await conversations.saveSession(session('c-global', 'u_caio'))
    await conversations.saveSession(session('c-root-beta', 'u_root', 'beta'))
  })

  type THandler = {
    [K in keyof AgentController]: AgentController[K] extends (req: Request, res: Response) => Promise<void> ? K : never
  }[keyof AgentController]
  const call = (as: string, handler: THandler, input: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {}) =>
    withCaller({ token: as, ...identityFromToken(as) }, async () => {
      const reply: { status: number; body?: { ok: boolean; result?: any } } = { status: 0 } // eslint-disable-line @typescript-eslint/no-explicit-any
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
      await controller[handler]({ params: input.params ?? {}, body: input.body ?? {}, query: input.query ?? {}, headers: {} } as unknown as Request, res)
      return reply
    })

  const agentBody = (id: string, projectId?: string) => ({
    id,
    name: id,
    providers: [{ provider: 'google', models: ['gemini-3.7-flash'] }],
    systemPrompt: 'Você pesquisa.',
    modes: ['chat', 'agent'],
    allowedTools: ['search_web'],
    ...(projectId ? { projectId } : {}),
  })
  const ids = (reply: { body?: { result?: any } }) => (reply.body!.result.sessions as Array<{ id: string }>).map((item) => item.id).sort() // eslint-disable-line @typescript-eslint/no-explicit-any

  it('criar agente: o admin do projeto do corpo; a Bia, o Caio e o root (que não é do alfa) recebem 404', async () => {
    assert.strictEqual((await call(ANA, 'createAgent', { body: agentBody('novo-alfa', 'alfa') })).status, 201)
    assert.strictEqual((await call(BIA, 'createAgent', { body: agentBody('intruso', 'alfa') })).status, 404)
    assert.strictEqual((await call(CAIO, 'createAgent', { body: agentBody('membro', 'alfa') })).status, 404)
    assert.strictEqual((await call(ROOT, 'createAgent', { body: agentBody('root-no-alfa', 'alfa') })).status, 404)
    assert.strictEqual(agents.get('intruso'), undefined)
  })

  it('o agente global só o root grava; o admin de projeto nem cria nem edita', async () => {
    assert.strictEqual((await call(ANA, 'createAgent', { body: agentBody('global-da-ana') })).status, 404)
    assert.strictEqual((await call(ROOT, 'createAgent', { body: agentBody('global-do-root') })).status, 201)
    assert.strictEqual((await call(ANA, 'updateAgent', { params: { agentId: 'global-do-root' }, body: agentBody('global-do-root') })).status, 404)
    assert.strictEqual((await call(ANA, 'getAgent', { params: { agentId: 'global-do-root' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'getAgent', { params: { agentId: 'global-do-root' } })).status, 200)
    assert.strictEqual((await call(ANA, 'deleteAgent', { params: { agentId: 'global-do-root' } })).status, 404)
  })

  it('ler, editar e apagar o agente do projeto: a Ana sim; a Bia e o root não', async () => {
    assert.strictEqual((await call(ANA, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 200)
    assert.strictEqual((await call(BIA, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'getAgentSystemPrompt', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ROOT, 'getAgentFootprint', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: agentBody('agente-alfa', 'alfa') })).status, 404)
    assert.strictEqual((await call(ROOT, 'deleteAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: agentBody('agente-alfa', 'alfa') })).status, 200)
  })

  it('⛔ mover o agente de projeto exige admin dos dois: a Ana não o leva para o beta', async () => {
    assert.strictEqual((await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: agentBody('agente-alfa', 'beta') })).status, 404)
    assert.strictEqual(agents.get('agente-alfa')?.projectId, 'alfa')
    assert.strictEqual((await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: agentBody('agente-alfa') })).status, 404)
  })

  it('agente global dentro de um projeto: o root precisa administrar os dois escopos para ler o prompt/tamanho', async () => {
    assert.strictEqual((await call(ROOT, 'getAgentSystemPrompt', { params: { agentId: 'pesquisa-teste' }, query: { project: 'alfa' } })).status, 404)
    assert.strictEqual((await call(ANA, 'getAgentSystemPrompt', { params: { agentId: 'pesquisa-teste' }, query: { project: 'alfa' } })).status, 404)
  })

  it('a lista de agentes: nem o root vê o agente de projeto que não é dele; a Ana vê o dela', async () => {
    const names = async (as: string) => ((await call(as, 'getAgents')).body!.result as Array<{ id: string }>).map((agent) => agent.id)
    assert.ok(!(await names(ROOT)).includes('agente-alfa'))
    assert.ok((await names(ANA)).includes('agente-alfa'))
    assert.ok(!(await names(ANA)).includes('agente-beta'))
  })

  it('abrir sessão: só o admin do agente troca o systemPrompt; o membro não', async () => {
    const body = { agentId: 'agente-alfa', systemPrompt: 'outro prompt', projectId: 'alfa' }
    assert.strictEqual((await call(CAIO, 'createSession', { body })).status, 422)
    assert.strictEqual((await call(ANA, 'createSession', { body })).status, 201)
  })

  it('conversa de projeto: o admin do projeto abre; a Bia e o root (admins de outro escopo) recebem 404; a sem projeto é do root', async () => {
    const turns = (as: string, id: string) => call(as, 'getConversationTurns', { params: { id } })
    assert.strictEqual((await turns(ANA, 'c-alfa')).status, 200)
    assert.strictEqual((await turns(BIA, 'c-alfa')).status, 404)
    assert.strictEqual((await turns(ROOT, 'c-alfa')).status, 404)
    assert.strictEqual((await turns(ROOT, 'c-beta')).status, 404)
    assert.strictEqual((await turns(ANA, 'c-global')).status, 404)
    assert.strictEqual((await turns(ROOT, 'c-global')).status, 200)
    // ⛔ O dono que NÃO usa mais o projeto (o root nunca foi membro do beta) perde a conversa dele.
    assert.strictEqual((await turns(ROOT, 'c-root-beta')).status, 404)
    assert.strictEqual((await turns(CAIO, 'c-alfa')).status, 200)
  })

  it('apagar e compartilhar seguem a mesma regra', async () => {
    assert.strictEqual((await call(BIA, 'shareConversation', { params: { id: 'c-alfa' }, body: { shared: true } })).status, 404)
    assert.strictEqual((await call(ROOT, 'deleteConversation', { params: { id: 'c-alfa' } })).status, 404)
  })

  it('o monitor (?scope=all): cada admin vê só o que administra; o membro comum, 404', async () => {
    const all = (as: string, query: Record<string, unknown> = {}) => call(as, 'listConversations', { query: { scope: 'all', ...query } })
    assert.deepStrictEqual(ids(await all(ANA)), ['c-alfa'])
    assert.deepStrictEqual(ids(await all(BIA)), ['c-beta', 'c-root-beta'])
    assert.deepStrictEqual(ids(await all(ROOT)), ['c-global'])
    assert.strictEqual((await all(CAIO)).status, 404)
    // `?project=` de outro: 404.
    assert.strictEqual((await all(ANA, { project: 'beta' })).status, 404)
    assert.strictEqual((await all(ROOT, { project: 'alfa' })).status, 404)
    assert.deepStrictEqual(ids(await all(ANA, { project: 'alfa' })), ['c-alfa'])
  })

  it('o monitor paginado: a mesma regra, com o total e as abas só do recorte', async () => {
    const page = async (as: string, query: Record<string, unknown> = {}) =>
      (await call(as, 'listConversations', { query: { scope: 'all', page: '1', pageSize: '10', ...query } })).body!.result
    const ana = await page(ANA)
    assert.deepStrictEqual(
      ana.sessions.map((item: { id: string }) => item.id),
      ['c-alfa'],
    )
    assert.strictEqual(ana.total, 1)
    assert.deepStrictEqual(ana.facets.provider, { google: 1 })
    const root = await page(ROOT)
    assert.deepStrictEqual(
      root.sessions.map((item: { id: string }) => item.id),
      ['c-global'],
    )
    assert.strictEqual(root.total, 1)
    // A caixa de entrada própria do root traz as dele, mesmo no beta (abrir a conversa, aí sim, exige o projeto).
    assert.deepStrictEqual(
      (await page(ROOT, { mine: '1' })).sessions.map((item: { id: string }) => item.id),
      ['c-root-beta'],
    )
  })

  it('as estatísticas e o registro de erros: só o recorte de quem administra', async () => {
    assert.strictEqual((await call(ANA, 'conversationStats')).body!.result.conversations, 1)
    assert.strictEqual((await call(ROOT, 'conversationStats')).body!.result.conversations, 1)
    assert.strictEqual((await call(CAIO, 'conversationStats')).status, 404)
    assert.strictEqual((await call(CAIO, 'listErrors')).status, 404)
    assert.strictEqual((await call(ANA, 'listErrors')).status, 200)
  })

  it('⛔ agente só de admin: os comandos e as ferramentas dele só para quem administra o projeto dele', async () => {
    assert.strictEqual((await call(ANA, 'getAgentCommands', { params: { agentId: 'agente-alfa-admin' } })).status, 200)
    assert.strictEqual((await call(CAIO, 'getAgentCommands', { params: { agentId: 'agente-alfa-admin' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'getAgentTools', { params: { agentId: 'agente-alfa-admin' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'getAgentCommands', { params: { agentId: 'agente-alfa' } })).status, 200, 'o agente comum segue para o membro')
  })

  it('o sistema continua do gateway: as configurações são do root; a Ana recebe 404', async () => {
    assert.strictEqual((await call(ROOT, 'getSettings')).status, 200)
    assert.strictEqual((await call(ANA, 'getSettings')).status, 404)
    assert.strictEqual((await call(ANA, 'updateSettings', { body: {} })).status, 404)
  })

  it('⛔ quem é REMOVIDO do projeto perde a conversa dele: 404 em turnos, mensagem e na lista; o admin do projeto segue', async () => {
    const DORA = token('u_dora', 'member')
    members.alfa!.u_dora = 'member'
    await conversations.saveSession(session('c-dora', 'u_dora', 'alfa'))
    const turns = (as: string) => call(as, 'getConversationTurns', { params: { id: 'c-dora' } })
    assert.strictEqual((await turns(DORA)).status, 200)
    delete members.alfa!.u_dora
    assert.strictEqual((await turns(DORA)).status, 404)
    const messaged = await withCaller({ token: DORA, ...identityFromToken(DORA) }, async () => {
      const reply = { status: 0 }
      const res = { status: (code: number) => ((reply.status = code), res), json: () => res } as unknown as Response
      await controller.sendMessage({ params: { id: 'c-dora' }, body: { message: 'oi' }, query: {}, headers: {} } as unknown as Request, res)
      return reply
    })
    assert.strictEqual(messaged.status, 404)
    assert.strictEqual((await call(DORA, 'sessionLive', { params: { id: 'c-dora' } })).status, 404)
    assert.ok(!ids(await call(DORA, 'listConversations')).includes('c-dora'))
    assert.strictEqual((await turns(ANA)).status, 200)
    await conversations.deleteSession('c-dora')
  })

  it('⛔ a conversa de DELEGAÇÃO não recebe mensagem direto pelo id, nem do dono', async () => {
    const resumed: string[] = []
    const direct = new AgentController({
      agents,
      catalog: { mcpUrl: '', mcpConnected: false, mcp: { list: () => [] }, list: async () => [] } as unknown as ToolCatalog,
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider, conversations),
      cancelSession: new CancelSessionUseCase(provider),
      reconfigureSession: new ReconfigureSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      resumeSession: { execute: async (stored: IConversationSession) => void resumed.push(stored.id) } as never,
      proof,
      settings: new NullSettingsRepository(),
      conversations,
      projects: projects as never,
    })
    await conversations.saveSession({ ...session('c-filha', 'u_caio'), metadata: { owner: { id: 'u_caio' }, delegatedBy: 'c-mae' } })
    await conversations.saveSession(session('c-mae', 'u_caio'))
    const send = (id: string, handler: 'sendMessage' | 'startTurn') =>
      withCaller({ token: CAIO, ...identityFromToken(CAIO) }, async () => {
        const reply = { status: 0 }
        const res = { status: (code: number) => ((reply.status = code), res), json: () => res, setHeader: () => res } as unknown as Response
        await direct[handler]({ params: { id }, body: { message: 'oi' }, query: {}, headers: {} } as unknown as Request, res)
        return reply
      })
    for (const handler of ['sendMessage', 'startTurn'] as const) assert.strictEqual((await send('c-filha', handler)).status, 404)
    assert.deepStrictEqual(resumed, [])
    await send('c-mae', 'sendMessage')
    assert.deepStrictEqual(resumed, ['c-mae'])
    await conversations.deleteSession('c-filha')
    await conversations.deleteSession('c-mae')
  })
})
