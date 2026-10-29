import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { ProjectsService } from '@application/Projects.Service'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
import { ResumeSessionUseCase } from '@application/ResumeSession.Usecase'
import { SendMessageUseCase } from '@application/SendMessage.Usecase'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { NullSettingsRepository } from '@infra/persistence/Null.SettingsRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteProjectRepository } from '@infra/persistence/Sqlite.ProjectRepository'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { CLAUDE_TEST_AGENT, GOOGLE_TEST_AGENT, OPENAI_TEST_AGENT, testAgentCatalog } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'
import { HttpServer } from './Http.Server'
import { ProjectsController } from './Projects.Controller'
import { GuidanceController } from './Guidance.Controller'
import { GuidanceService } from '@application/Guidance.Service'
import { SqliteGuidanceRepository } from '@infra/persistence/Sqlite.GuidanceRepository'
import { builderAgent } from '@domain/Builder.Agents'

/**
 * Projetos de ponta a ponta: o membro de um projeto não vê nada do outro, o agente global aparece nos dois,
 * e a conversa leva o projeto escrito pelo servidor (o cliente não forja).
 */
describe('Projetos (integração)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const token = (id: string, role: 'admin' | 'member') => tokens.issue({ sub: id, email: `${id}@x.test`, role, ver: 0 }).token
  const ADMIN = token('u_root', 'admin')
  const ANA = token('u_ana', 'member')
  const BIA = token('u_bia', 'member')

  const sessions = new Map<string, ISession>()
  const received: Array<{ sessionId: string; text: string }> = []
  const provider = {
    createSession: async (input: ICreateSessionInput) => {
      const id = `s-${sessions.size + 1}`
      const now = new Date()
      sessions.set(id, {
        id,
        agentId: input.agentId!,
        provider: EProvider.CLAUDE,
        mode: EMode.AGENT,
        model: 'm',
        tools: false,
        status: 'idle',
        turns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        lastActivityAt: now,
        metadata: input.metadata,
      } as ISession)
      return { id, provider: EProvider.CLAUDE, mode: EMode.AGENT, createdAt: now, metadata: input.metadata }
    },
    sendMessage: async function* (sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
      received.push({ sessionId, text: `${input.context ?? ''}\n${input.text}` })
      yield { type: 'message.completed', sessionId, timestamp: new Date() } as IAgentEvent
    },
    cancel: async () => undefined,
    dispose: async () => undefined,
    describe: (id: string) => {
      const session = sessions.get(id)
      if (!session) throw Object.assign(new Error(`Session not found: ${id}`), { name: 'SessionNotFoundError' })
      return session
    },
    reconfigure: () => {
      throw new Error('not used')
    },
    list: () => [...sessions.values()],
    // A retomada de verdade está nos testes do AgentProvider; aqui basta devolver a sessão ao mapa.
    resume: async ({ session }: { session: { id: string; agentId: string; metadata?: Record<string, unknown> } }) => {
      resumed.push(session.id)
      const now = new Date()
      sessions.set(session.id, {
        id: session.id,
        agentId: session.agentId,
        provider: EProvider.CLAUDE,
        mode: EMode.AGENT,
        model: 'm',
        tools: false,
        status: 'idle',
        turns: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: now,
        lastActivityAt: now,
        metadata: session.metadata,
      } as ISession)
    },
  } as unknown as IAgentProvider
  const resumed: string[] = []

  const folders = mkdtempSync(join(tmpdir(), 'gw-projects-test-'))
  const agents = testAgentCatalog(undefined, undefined, () => [builderAgent('skill', { provider: EProvider.CLAUDE, models: ['m'] })])
  const projects = new ProjectsService(
    new SqliteProjectRepository(':memory:'),
    () => agents.list(),
    (id) => ['u_root', 'u_ana', 'u_bia'].includes(id),
    {
      create: (id) => (mkdirSync(join(folders, id), { recursive: true }), join(folders, id)),
      remove: (id) => rmSync(join(folders, id), { recursive: true, force: true }),
    },
  )
  const proof = { prove: async (value: string) => !!tokens.verify(value) }
  const guidance = new GuidanceService(
    new SqliteGuidanceRepository(':memory:'),
    (id) => projects.exists(id),
    (id) => {
      const agent = agents.get(id)
      return agent ? { id: agent.id, ...(agent.projectId ? { projectId: agent.projectId } : {}) } : undefined
    },
  )
  let base = ''
  let stop = () => undefined as void

  before(async () => {
    const conversations = new SqliteConversationRepository(':memory:')
    const controller = new AgentController({
      agents,
      catalog: { mcpConnected: false, list: async () => [], localFor: () => [], mcp: { list: () => [], probeTools: async () => [] } } as unknown as ToolCatalog,
      createSession: new CreateSessionUseCase(provider),
      sendMessage: new SendMessageUseCase(provider, conversations),
      cancelSession: new CancelSessionUseCase(provider),
      reconfigureSession: new ReconfigureSessionUseCase(provider),
      deleteSession: new DeleteSessionUseCase(provider),
      getSession: new GetSessionUseCase(provider),
      listSessions: new ListSessionsUseCase(provider),
      resumeSession: new ResumeSessionUseCase(provider, conversations),
      proof,
      settings: new NullSettingsRepository(),
      conversations,
      projects,
      guidance,
    })
    const server = new HttpServer(
      controller,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new ProjectsController({ projects, proof }),
      new GuidanceController({ guidance, proof }),
    ).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })
  after(() => {
    stop()
    rmSync(folders, { recursive: true, force: true })
  })

  const call = (as: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'X-Tool-Authorization': `Bearer ${as}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(
      async (res) => ({ status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string; details?: any } }), // eslint-disable-line @typescript-eslint/no-explicit-any
    )
  const agentIds = async (as: string, project?: string) =>
    ((await call(as, 'GET', `/agents${project ? `?project=${project}` : ''}`)).body.result as Array<{ id: string }>).map((agent) => agent.id).sort()

  it('o admin cria projetos (com a pasta) e escolhe os membros; cada um vê só os seus', async () => {
    assert.strictEqual((await call(ADMIN, 'POST', '/projects', { id: 'alfa', name: 'Alfa' })).status, 201)
    assert.strictEqual((await call(ADMIN, 'POST', '/projects', { id: 'beta', name: 'Beta' })).status, 201)
    assert.strictEqual((await call(ANA, 'POST', '/projects', { id: 'gama', name: 'Gama' })).status, 404, 'membro não cria projeto')
    assert.ok(existsSync(join(folders, 'alfa')))
    await call(ADMIN, 'PUT', '/projects/alfa/members', { userIds: ['u_ana'] })
    await call(ADMIN, 'PUT', '/projects/beta/members', { userIds: ['u_bia'] })
    assert.strictEqual((await call(ADMIN, 'PUT', '/projects/beta/members', { userIds: ['u_fantasma'] })).status, 422)

    assert.deepStrictEqual(
      ((await call(ANA, 'GET', '/projects')).body.result as Array<{ id: string; folder?: string }>).map((project) => [project.id, project.folder]),
      [['alfa', undefined]],
    )
    assert.deepStrictEqual(
      ((await call(ADMIN, 'GET', '/projects')).body.result as Array<{ id: string }>).map((project) => project.id),
      ['alfa', 'beta'],
    )
  })

  it('⛔ o agente de projeto só aparece para os membros dele; o global aparece em todos', async () => {
    agents.moveToProject(CLAUDE_TEST_AGENT.id, 'alfa', 'teste')
    agents.moveToProject(OPENAI_TEST_AGENT.id, 'beta', 'teste')
    assert.deepStrictEqual(await agentIds(ANA, 'alfa'), [CLAUDE_TEST_AGENT.id, GOOGLE_TEST_AGENT.id].sort())
    assert.deepStrictEqual(await agentIds(ANA), [CLAUDE_TEST_AGENT.id, GOOGLE_TEST_AGENT.id].sort(), 'sem ?project, o que ela pode usar')
    assert.strictEqual((await call(ANA, 'GET', '/agents?project=beta')).status, 404, 'projeto alheio responde como inexistente')
    assert.deepStrictEqual(await agentIds(BIA), [GOOGLE_TEST_AGENT.id, OPENAI_TEST_AGENT.id].sort(), 'e a Bia, só o do projeto dela e o global')
    assert.deepStrictEqual(await agentIds(ADMIN, 'beta'), [GOOGLE_TEST_AGENT.id, OPENAI_TEST_AGENT.id].sort())
  })

  it('⛔ abrir conversa no agente de outro projeto: 404; no do próprio, a conversa leva o projeto — e o forjado some', async () => {
    assert.strictEqual((await call(ANA, 'POST', '/sessions', { agentId: OPENAI_TEST_AGENT.id })).status, 404)

    const opened = await call(ANA, 'POST', '/sessions', { agentId: CLAUDE_TEST_AGENT.id, metadata: { project: 'beta', origem: 'tela' } })
    assert.strictEqual(opened.status, 201)
    const session = sessions.get(opened.body.result.id)!
    assert.deepStrictEqual([session.metadata?.project, session.metadata?.origem], ['alfa', 'tela'])

    await call(ANA, 'POST', `/sessions/${opened.body.result.id}/messages`, { message: 'oi' })
    assert.match(received.at(-1)!.text, /Projeto: Alfa \(alfa\)\. Sua pasta de trabalho é .*alfa/)
  })

  it('o agente global aberto dentro de um projeto fica nele; num projeto alheio, 404', async () => {
    const opened = await call(ANA, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id, projectId: 'alfa' })
    assert.strictEqual(sessions.get(opened.body.result.id)?.metadata?.project, 'alfa')
    await call(ANA, 'POST', `/sessions/${opened.body.result.id}/messages`, { message: 'crie um agente' })
    assert.match(received.at(-1)!.text, /Projeto atual: Alfa \(projectId "alfa"\)/)

    assert.strictEqual((await call(ANA, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id, projectId: 'beta' })).status, 404)
    const loose = await call(ANA, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id })
    assert.strictEqual(sessions.get(loose.body.result.id)?.metadata?.project, undefined, 'sem projeto pedido, o global fica sem projeto')
  })

  it('a caixa de entrada filtra pelo projeto, e o projeto alheio dá 404', async () => {
    const mine = (await call(ANA, 'GET', '/conversations?project=alfa')).body.result.sessions as Array<{ metadata: { project?: string } }>
    assert.ok(mine.length >= 2)
    assert.ok(mine.every((session) => session.metadata.project === 'alfa'))
    assert.strictEqual((await call(ANA, 'GET', '/conversations?project=beta')).status, 404)
    const page = (await call(ADMIN, 'GET', '/conversations?scope=all&page=1&project=alfa')).body.result
    assert.ok(page.sessions.length >= 2 && page.sessions.every((session: { metadata: { project?: string } }) => session.metadata.project === 'alfa'))
  })

  it('⛔ salvar agente: projeto inexistente e delegação para outro projeto são recusados; apagar projeto com agente, 409', async () => {
    const detail = (await call(ADMIN, 'GET', `/agents/${CLAUDE_TEST_AGENT.id}`)).body.result
    const body = { ...detail, providers: detail.providers.map((target: { id: string; models: string[] }) => ({ provider: target.id, models: target.models })) }
    const ghost = await call(ADMIN, 'PUT', `/agents/${CLAUDE_TEST_AGENT.id}`, { ...body, projectId: 'nao-existe' })
    assert.strictEqual(ghost.status, 422)
    assert.ok((ghost.body.details as Array<{ field: string }>).some((issue) => issue.field === 'projectId'))
    const crossing = await call(ADMIN, 'PUT', `/agents/${CLAUDE_TEST_AGENT.id}`, { ...body, allowedTools: [`agent:${OPENAI_TEST_AGENT.id}`] })
    assert.ok((crossing.body.details as Array<{ message: string }>).some((issue) => /another project/.test(issue.message)))

    const busy = await call(ADMIN, 'DELETE', '/projects/beta')
    assert.deepStrictEqual([busy.status, busy.body.code], [409, 'project_in_use'])
  })

  it('⛔ rules e documentos são só do admin: para o membro, nem existem (404)', async () => {
    const rule = await call(ADMIN, 'POST', '/rules', { title: 'Português', body: 'Responda em português.' })
    assert.deepStrictEqual([rule.status, rule.body.result.position], [201, 1])
    const doc = await call(ADMIN, 'POST', '/docs', { id: 'api', kind: 'adr', title: 'API', summary: 'REST', body: '# API' })
    assert.strictEqual(doc.status, 201)
    assert.strictEqual((await call(ADMIN, 'GET', '/docs?project=global')).body.result[0].body, undefined)
    assert.strictEqual((await call(ADMIN, 'GET', '/docs/api')).body.result.body, '# API')

    for (const [method, path] of [
      ['GET', '/rules'],
      ['POST', '/rules'],
      ['GET', '/docs'],
      ['GET', '/docs/api'],
      ['DELETE', `/rules/${rule.body.result.id}`],
    ])
      assert.strictEqual((await call(ANA, method, path, method === 'POST' ? { title: 'x', body: 'y' } : undefined)).status, 404, `${method} ${path}`)
  })

  it('⛔ o contexto inicial do projeto é do admin: grava e lê; para o membro, 404', async () => {
    await call(ADMIN, 'POST', '/projects', { id: 'ctx', name: 'Ctx' })
    await call(ADMIN, 'POST', '/docs', { id: 'seg', kind: 'spec', title: 'Segurança', summary: 's', body: 'Nunca exponha segredos.' })
    const saved = await call(ADMIN, 'PUT', '/projects/ctx/initial-context', { docIds: ['seg'] })
    assert.deepStrictEqual([saved.status, saved.body.result.totalTokens], [200, 6])
    assert.deepStrictEqual(
      (await call(ADMIN, 'GET', '/projects/ctx/initial-context')).body.result.docs.map((doc: { id: string }) => doc.id),
      ['seg'],
    )
    assert.deepStrictEqual((await call(ADMIN, 'GET', '/docs')).body.result.find((doc: { id: string }) => doc.id === 'seg').loadedIn.projects, ['ctx'])
    assert.strictEqual((await call(ADMIN, 'PUT', '/projects/ctx/initial-context', { docIds: ['api'] })).status, 422)
    assert.strictEqual((await call(ANA, 'GET', '/projects/ctx/initial-context')).status, 404)
    assert.strictEqual((await call(ANA, 'PUT', '/projects/ctx/initial-context', { docIds: [] })).status, 404)
  })

  it('⛔ o contexto inicial do agente é do admin; agente que não existe é 404', async () => {
    await call(ADMIN, 'POST', '/docs', { id: 'arq', kind: 'spec', title: 'Arquitetura', summary: 'a', body: 'Hexagonal.' })
    const saved = await call(ADMIN, 'PUT', `/agents/${CLAUDE_TEST_AGENT.id}/initial-context`, { docIds: ['arq'] })
    assert.deepStrictEqual([saved.status, saved.body.result.docs.map((doc: { id: string }) => doc.id)], [200, ['arq']])
    assert.deepStrictEqual((await call(ADMIN, 'GET', '/docs')).body.result.find((doc: { id: string }) => doc.id === 'arq').loadedIn.agents, [CLAUDE_TEST_AGENT.id])
    assert.strictEqual((await call(ADMIN, 'GET', '/agents/nao-existe/initial-context')).status, 404)
    assert.strictEqual((await call(ANA, 'GET', `/agents/${CLAUDE_TEST_AGENT.id}/initial-context`)).status, 404)
  })

  it('⛔ a conversa cuja sessão expirou é retomada pelo dono ao mandar mensagem; por outra pessoa, 404 e nada reabre', async () => {
    const opened = await call(ANA, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id, projectId: 'alfa' })
    const id = opened.body.result.id as string
    await call(ANA, 'POST', `/sessions/${id}/messages`, { message: 'primeira' })
    sessions.delete(id)

    assert.strictEqual((await call(BIA, 'POST', `/sessions/${id}/messages`, { message: 'invadir' })).status, 404)
    assert.deepStrictEqual(resumed, [])

    const again = await call(ANA, 'POST', `/sessions/${id}/messages`, { message: 'segunda' })
    assert.strictEqual(again.status, 200)
    assert.deepStrictEqual(resumed, [id])
    const turns = (await call(ANA, 'GET', `/conversations/${id}/turns`)).body.result.turns as Array<{ request: string }>
    assert.deepStrictEqual(
      turns.map((turn) => turn.request),
      ['primeira', 'segunda'],
    )
  })

  it('⛔ o tamanho do agente é do admin: as partes e o total; para o membro, 404', async () => {
    const result = await call(ADMIN, 'GET', `/agents/${CLAUDE_TEST_AGENT.id}/footprint`)
    assert.strictEqual(result.status, 200)
    assert.ok(result.body.result.sections.some((section: { key: string }) => section.key === 'instructions'))
    assert.ok(result.body.result.total > 0)
    assert.strictEqual((await call(ANA, 'GET', `/agents/${CLAUDE_TEST_AGENT.id}/footprint`)).status, 404)
    assert.strictEqual((await call(ADMIN, 'GET', '/agents/nao-existe/footprint')).status, 404)
  })

  it('skills e commands: o cadastro é do admin; o membro vê os commands do agente e o /command chega expandido, gravado como digitado', async () => {
    const created = await call(ADMIN, 'POST', '/resources', { id: 'saudar', kind: 'command', description: 'Cumprimenta alguém', body: 'Diga olá para $ARGUMENTS.' })
    assert.strictEqual(created.status, 201)
    assert.strictEqual((await call(ANA, 'POST', '/resources', { id: 'x', kind: 'skill', description: 'x', body: 'x' })).status, 404)
    assert.strictEqual((await call(ANA, 'GET', '/resources')).status, 404)
    assert.strictEqual((await call(ADMIN, 'PUT', `/agents/${GOOGLE_TEST_AGENT.id}/resources`, { skills: [], commands: ['saudar'] })).status, 200)

    const listed = await call(ANA, 'GET', `/agents/${GOOGLE_TEST_AGENT.id}/commands`)
    assert.deepStrictEqual(
      [listed.status, (listed.body.result as Array<{ kind: string }>).filter((item) => item.kind === 'command' || item.kind === 'skill')],
      [200, [{ id: 'saudar', kind: 'command', description: 'Cumprimenta alguém' }]],
    )

    const opened = await call(ANA, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id, projectId: 'alfa' })
    const id = opened.body.result.id as string
    assert.strictEqual((await call(ANA, 'POST', `/sessions/${id}/messages`, { message: '/saudar Maria' })).status, 200)
    assert.match(received.at(-1)!.text, /Diga olá para Maria\.$/)
    const turns = (await call(ANA, 'GET', `/conversations/${id}/turns`)).body.result.turns as Array<{ request: string }>
    assert.strictEqual(turns.at(-1)!.request, '/saudar Maria')

    // Os documentos da conversa também: os globais e os do projeto pedido (o alheio, não).
    await call(ADMIN, 'POST', '/docs', { id: 'tom', kind: 'spec', title: 'Tom de voz', summary: 'Como falar', body: 'Seja breve.', projectId: 'alfa' })
    const withDocs = (await call(ANA, 'GET', `/agents/${GOOGLE_TEST_AGENT.id}/commands?project=alfa`)).body.result as Array<{ id: string; kind: string }>
    assert.ok(withDocs.some((item) => item.id === 'spec:tom' && item.kind === 'spec'))
    const elsewhere = (await call(ANA, 'GET', `/agents/${GOOGLE_TEST_AGENT.id}/commands?project=beta`)).body.result as Array<{ id: string }>
    assert.ok(!elsewhere.some((item) => item.id === 'spec:tom'))
    await call(ANA, 'POST', `/sessions/${id}/messages`, { message: '/spec:tom responda oi' })
    assert.match(received.at(-1)!.text, /# Tom de voz \[spec\]\n\nSeja breve\.\n\n# Pedido\n\nresponda oi$/)
  })

  it('⛔ o construtor: só o admin abre; a conversa nasce marcada (a marca do corpo não vale) e fica fora da caixa de entrada', async () => {
    assert.strictEqual((await call(ANA, 'POST', '/sessions', { agentId: 'builder-skill', projectId: 'alfa' })).status, 404)
    assert.ok(!(await agentIds(ADMIN)).includes('builder-skill'), 'o construtor não aparece em Agentes')

    const opened = await call(ADMIN, 'POST', '/sessions', { agentId: 'builder-skill', projectId: 'alfa' })
    assert.strictEqual(opened.status, 201)
    const id = opened.body.result.id as string
    assert.deepStrictEqual([sessions.get(id)?.metadata?.builder, sessions.get(id)?.metadata?.project], ['skill', 'alfa'])
    await call(ADMIN, 'POST', `/sessions/${id}/messages`, { message: 'quero uma skill' })

    const forged = await call(ADMIN, 'POST', '/sessions', { agentId: GOOGLE_TEST_AGENT.id, projectId: 'alfa', metadata: { builder: 'skill' } })
    assert.strictEqual(sessions.get(forged.body.result.id)?.metadata?.builder, undefined)

    // O turno chega ao banco um instante depois do stream.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const inbox = (await call(ADMIN, 'GET', '/conversations?project=alfa')).body.result.sessions as Array<{ id: string }>
    assert.ok(!inbox.some((session) => session.id === id))
    const monitor = (await call(ADMIN, 'GET', '/conversations?scope=all&page=1&project=alfa')).body.result.sessions as Array<{ id: string }>
    assert.ok(!monitor.some((session) => session.id === id), 'nem na lista paginada do admin')
    const builds = (await call(ADMIN, 'GET', '/conversations?project=alfa&builder=skill')).body.result.sessions as Array<{ id: string }>
    assert.deepStrictEqual(
      builds.map((session) => session.id),
      [id],
    )
  })

  it('⛔ o protocolo é do admin: o do core e o complemento por escopo; para o membro, 404', async () => {
    const core = await call(ADMIN, 'GET', '/protocols/skill?project=alfa')
    assert.strictEqual(core.status, 200)
    assert.match(core.body.result.core.body, /Protocolo de construção de skill/)
    const saved = await call(ADMIN, 'PUT', '/protocols/skill/addendum', { projectId: 'alfa', body: 'O id começa com alfa-.' })
    assert.deepStrictEqual([saved.status, saved.body.result.addenda.project.body], [200, 'O id começa com alfa-.'])
    assert.strictEqual((await call(ADMIN, 'GET', '/protocols/agente')).status, 422)
    const adr = await call(ADMIN, 'GET', '/protocols/adr')
    assert.match(adr.body.result.core.body, /Protocolo de construção de ADR/)
    const rule = await call(ADMIN, 'PUT', '/protocols/rule/addendum', { projectId: 'alfa', body: 'Rule em português.' })
    assert.strictEqual(rule.body.result.addenda.project.body, 'Rule em português.')
    assert.strictEqual((await call(ANA, 'GET', '/protocols/skill')).status, 404)
    assert.strictEqual((await call(ANA, 'PUT', '/protocols/skill/addendum', { body: 'x' })).status, 404)
  })
})
