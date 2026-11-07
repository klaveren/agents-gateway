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
 * ⛔ Compartilhar um AGENTE entre projetos (ver `Share.Policy`): a Ana administra `alfa` e `beta`; a Bia, só `beta`; o Caio,
 * só `gama`; a Dora é membro de `beta`. O agente é do `alfa`.
 */
describe('AgentController: compartilhar o agente com outro projeto', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string) => tokens.issue({ sub: id, email: `${id}@x.test`, role: 'member', ver: 0 }).token
  const ANA = token('u_ana')
  const BIA = token('u_bia')
  const CAIO = token('u_caio')
  const DORA = token('u_dora')
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const members: Record<string, Record<string, 'admin' | 'member'>> = {
    alfa: { u_ana: 'admin' },
    beta: { u_ana: 'admin', u_bia: 'admin', u_dora: 'member' },
    gama: { u_caio: 'admin' },
  }

  const repository = new NullAgentRepository()
  repository.seedOnce(
    [
      ...TEST_AGENTS,
      { ...GOOGLE_TEST_AGENT, id: 'agente-alfa', name: 'Agente alfa', projectId: 'alfa' },
      { ...GOOGLE_TEST_AGENT, id: 'agente-alfa-admin', name: 'Só admin', projectId: 'alfa', adminOnly: true },
    ],
    'teste',
  )
  const agents = new AgentCatalog(repository)
  const secretsKept: Array<[string, readonly string[]]> = []
  agents.useShares({ exists: (id) => id in members, changed: (agentId, projects) => secretsKept.push([agentId, projects]) })

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
  const opened: Array<{ agentId?: string; metadata?: Record<string, unknown> }> = []
  const provider = {
    createSession: async (input: { agentId?: string; metadata?: Record<string, unknown> }) => {
      opened.push(input)
      return { id: 'novo', provider: EProvider.GOOGLE, mode: EMode.CHAT, createdAt: new Date() }
    },
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
  const share = (as: string, list: string[], agentId = 'agente-alfa') => call(as, 'shareAgent', { params: { agentId }, body: { projects: list } })
  const listed = async (as: string, project: string) =>
    ((await call(as, 'getAgents', { query: { project } })).body!.result as Array<{ id: string; sharedFrom?: string; sharedWith?: string[] }>).filter((agent) =>
      agent.id.startsWith('agente-'),
    )
  const body = (id: string, projectId: string) => ({
    id,
    name: id,
    providers: [{ provider: 'google', models: ['gemini-3.7-flash'] }],
    systemPrompt: 'x',
    modes: ['chat'],
    allowedTools: ['search_web'],
    projectId,
  })

  it('⛔ só compartilha quem administra a origem E o destino; agente global não se compartilha', async () => {
    assert.strictEqual((await share(BIA, ['beta'])).status, 404, 'a Bia não administra alfa')
    assert.strictEqual((await share(ANA, ['gama'])).status, 404, 'a Ana não administra gama')
    assert.strictEqual((await share(CAIO, ['gama'])).status, 404)
    assert.strictEqual((await share(ANA, ['nao-existe'])).status, 404, 'projeto que ela não administra (nem existe) é 404')
    assert.strictEqual((await share(ANA, ['alfa'])).status, 422, 'o próprio projeto do agente')
    assert.strictEqual((await share(ANA, ['beta'], 'pesquisa-teste')).status, 404, 'o global é do gateway: a Ana não o compartilha')
    const done = await share(ANA, ['beta'])
    assert.deepStrictEqual([done.status, done.body?.result.sharedWith], [200, ['beta']])
    assert.deepStrictEqual(agents.get('agente-alfa')?.sharedWith, ['beta'])
  })

  it('o projeto que recebe lista (com `sharedFrom`) e só a origem vê com quem compartilha', async () => {
    assert.deepStrictEqual(
      (await listed(DORA, 'beta')).map((agent) => [agent.id, agent.sharedFrom, agent.sharedWith]),
      [['agente-alfa', 'alfa', undefined]],
      'só o compartilhado: o adminOnly e os outros do alfa não vêm',
    )
    // O admin do beta também não vê com quem a origem compartilha.
    assert.strictEqual((await listed(BIA, 'beta'))[0]!.sharedWith, undefined)
    assert.deepStrictEqual((await listed(ANA, 'alfa')).find((agent) => agent.id === 'agente-alfa')?.sharedWith, ['beta'])
    assert.deepStrictEqual(await listed(CAIO, 'gama'), [], 'o gama não recebeu')
    assert.strictEqual((await call(CAIO, 'getAgents', { query: { project: 'beta' } })).status, 404, 'projeto que ele não usa')
  })

  it('⛔ o admin do projeto que recebe LÊ o agente (só leitura) e não edita, não apaga, não compartilha: 404', async () => {
    const read = await call(BIA, 'getAgent', { params: { agentId: 'agente-alfa' } })
    assert.deepStrictEqual([read.status, read.body?.result.sharedFrom, read.body?.result.sharedWith], [200, 'alfa', ['beta']])
    assert.strictEqual((await call(CAIO, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(DORA, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 404, 'membro não administra')
    assert.strictEqual((await call(BIA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: body('agente-alfa', 'alfa') })).status, 404)
    assert.strictEqual((await call(BIA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: body('agente-alfa', 'beta') })).status, 404, 'nem para levá-lo para o beta')
    assert.strictEqual((await call(BIA, 'deleteAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(BIA, 'getAgentSystemPrompt', { params: { agentId: 'agente-alfa' }, query: { project: 'beta' } })).status, 404)
    assert.strictEqual((await share(BIA, [])).status, 404)
    assert.deepStrictEqual(agents.get('agente-alfa')?.sharedWith, ['beta'])
  })

  it('⛔ a edição da origem não mexe na lista (nem o corpo consegue mudá-la)', async () => {
    const edited = await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: { ...body('agente-alfa', 'alfa'), sharedWith: ['gama'] } })
    assert.strictEqual(edited.status, 200)
    assert.deepStrictEqual(agents.get('agente-alfa')?.sharedWith, ['beta'])
  })

  it('o membro do projeto que recebe conversa: a conversa nasce no projeto dele; quem não é dele, 404', async () => {
    opened.length = 0
    const dora = await call(DORA, 'createSession', { body: { agentId: 'agente-alfa', projectId: 'beta' } })
    assert.strictEqual(dora.status, 201)
    assert.strictEqual(opened.at(-1)?.metadata?.project, 'beta')
    // Sem `projectId` o projeto é o do agente: a Dora não é do alfa.
    assert.strictEqual((await call(DORA, 'createSession', { body: { agentId: 'agente-alfa' } })).status, 404)
    // O Caio (gama) não usa o beta.
    assert.strictEqual((await call(CAIO, 'createSession', { body: { agentId: 'agente-alfa', projectId: 'beta' } })).status, 404)
    // O agente só de admin segue só de admin, e o não compartilhado não tem como ser aberto no beta.
    assert.strictEqual((await call(DORA, 'createSession', { body: { agentId: 'agente-alfa-admin', projectId: 'beta' } })).status, 404)
    // A Ana sem pedir o beta: a conversa é do alfa, como sempre.
    await call(ANA, 'createSession', { body: { agentId: 'agente-alfa' } })
    assert.strictEqual(opened.at(-1)?.metadata?.project, 'alfa')
  })

  it('⛔ trocar o systemPrompt é do admin do agente (a origem); a Bia, admin do beta, não', async () => {
    const swap = { agentId: 'agente-alfa', projectId: 'beta', systemPrompt: 'outro' }
    assert.strictEqual((await call(BIA, 'createSession', { body: swap })).status, 422)
    assert.strictEqual((await call(ANA, 'createSession', { body: swap })).status, 201)
  })

  it('os comandos do agente compartilhado para o membro do beta (com ?project=beta); sem o projeto, 404', async () => {
    assert.strictEqual((await call(DORA, 'getAgentCommands', { params: { agentId: 'agente-alfa' }, query: { project: 'beta' } })).status, 200)
    assert.strictEqual((await call(DORA, 'getAgentCommands', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(CAIO, 'getAgentCommands', { params: { agentId: 'agente-alfa' }, query: { project: 'beta' } })).status, 404)
  })

  it('parar de compartilhar: o agente some do beta e a conversa nova é 404; os valores secretos de quem saiu são apagados', async () => {
    secretsKept.length = 0
    assert.strictEqual((await share(ANA, [])).status, 200)
    assert.deepStrictEqual(secretsKept, [['agente-alfa', []]])
    assert.deepStrictEqual(await listed(DORA, 'beta'), [])
    assert.strictEqual((await call(BIA, 'getAgent', { params: { agentId: 'agente-alfa' } })).status, 404)
    assert.strictEqual((await call(DORA, 'createSession', { body: { agentId: 'agente-alfa', projectId: 'beta' } })).status, 404)
    assert.strictEqual(agents.get('agente-alfa')?.sharedWith, undefined)
  })

  it('mudar o agente de projeto tira o novo dono da lista; apagar o projeto que recebia tira da lista', async () => {
    await share(ANA, ['beta'])
    secretsKept.length = 0
    // A Ana (admin de alfa e beta) leva o agente para o beta: o beta, agora dono, sai da lista.
    assert.strictEqual((await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: body('agente-alfa', 'beta') })).status, 200)
    assert.strictEqual(agents.get('agente-alfa')?.sharedWith, undefined)
    assert.deepStrictEqual(secretsKept.at(-1), ['agente-alfa', []])
    await call(ANA, 'updateAgent', { params: { agentId: 'agente-alfa' }, body: body('agente-alfa', 'alfa') })
    await share(ANA, ['beta'])
    agents.removeProject('beta', 'sistema')
    assert.strictEqual(agents.get('agente-alfa')?.sharedWith, undefined)
  })
})
