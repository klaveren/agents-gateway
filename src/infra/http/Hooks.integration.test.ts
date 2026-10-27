import assert from 'node:assert'
import { createHmac, randomBytes } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { AgentHooksService } from '@application/AgentHooks.Service'
import { CancelSessionUseCase } from '@application/CancelSession.Usecase'
import { CreateSessionUseCase } from '@application/CreateSession.Usecase'
import { DeleteSessionUseCase } from '@application/DeleteSession.Usecase'
import { GetSessionUseCase } from '@application/GetSession.Usecase'
import { ListSessionsUseCase } from '@application/ListSessions.Usecase'
import { ReconfigureSessionUseCase } from '@application/ReconfigureSession.Usecase'
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
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
import { SqliteConversationRepository } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { ToolCatalog } from '@infra/tools/Tool.Catalog'
import { CLAUDE_TEST_AGENT, testAgentCatalog } from '../../testing/Agents.Fixture'
import { AgentController } from './Agent.Controller'
import { HooksController } from './Hooks.Controller'
import { HttpServer } from './Http.Server'

/**
 * O hook de ponta a ponta: servidor de verdade, a conversa aberta PELA API com uma sessão de verdade da conta
 * que criou o hook, e um provider falso que registra o que o agente recebeu.
 */
describe('Hooks dos agentes (integração)', () => {
  const tokens = new HmacTokenIssuer(randomBytes(32).toString('hex'))
  const accounts: Record<string, { email: string; role: 'admin' | 'member'; disabled?: boolean }> = {
    u_root: { email: 'root@x.test', role: 'admin' },
    u_off: { email: 'off@x.test', role: 'admin', disabled: true },
  }
  const sessionFor = (id: string) => {
    const account = accounts[id]
    return account && !account.disabled ? tokens.issue({ sub: id, email: account.email, role: account.role, ver: 0 }) : undefined
  }
  const adminToken = sessionFor('u_root')!.token

  const sessions = new Map<string, ISession>()
  const received: Array<{ sessionId: string; text: string; at: number; done?: number }> = []
  let turnDelay = 0
  const provider = {
    createSession: async (input: ICreateSessionInput) => {
      const id = `s-${sessions.size + 1}`
      const now = new Date()
      sessions.set(id, {
        id,
        agentId: input.agentId ?? CLAUDE_TEST_AGENT.id,
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
      const entry: { sessionId: string; text: string; at: number; done?: number } = { sessionId, text: input.text ?? '', at: Date.now() }
      received.push(entry)
      await new Promise((resolve) => setTimeout(resolve, turnDelay))
      entry.done = Date.now()
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
  } as unknown as IAgentProvider

  const hooks = new AgentHooksService(
    new SqliteAgentHookRepository(':memory:'),
    new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'),
    (id) => id === CLAUDE_TEST_AGENT.id,
  )
  const proof = { prove: async (token: string) => !!tokens.verify(token) }
  let base = ''
  let stop = () => undefined as void

  before(async () => {
    const conversations = new SqliteConversationRepository(':memory:')
    const controller = new AgentController({
      agents: testAgentCatalog(),
      catalog: { mcpConnected: false, list: async () => [], mcp: { list: () => [] } } as unknown as ToolCatalog,
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
    })
    const server = new HttpServer(controller, undefined, undefined, undefined, undefined, undefined, undefined, new HooksController({ hooks, proof, sessionFor })).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })
  after(() => stop())

  const admin = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'X-Tool-Authorization': `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(
      async (res) => ({ status: res.status, body: (await res.json()) as { ok: boolean; result?: any; code?: string } }), // eslint-disable-line @typescript-eslint/no-explicit-any
    )
  const fire = (name: string, body: string, headers: Record<string, string>) =>
    fetch(`${base}/hook/${CLAUDE_TEST_AGENT.id}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }).then(async (res) => ({
      status: res.status,
      body: (await res.json()) as { ok: boolean; result?: { conversationId: string; queued: boolean }; code?: string },
    }))
  const settle = async (count: number) => {
    for (let i = 0; i < 100 && received.filter((entry) => entry.done).length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('chave certa: 202 na hora, a conversa nasce em nome de quem criou, e o agente recebe o prompt com o evento (sem a chave)', async () => {
    const created = await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`, { name: 'deploy', prompt: 'Resuma o evento em uma frase.' })
    assert.strictEqual(created.status, 201)
    const secret = created.body.result.secret as string
    assert.match(secret, /^whk_/)
    assert.strictEqual((await admin('GET', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`)).body.result[0].secret, undefined, 'a chave não volta na lista')

    const reply = await fire('deploy', JSON.stringify({ ref: 'main', ok: true }), { Authorization: `Bearer ${secret}`, 'X-GitHub-Event': 'push' })
    assert.strictEqual(reply.status, 202)
    await settle(1)
    const turn = received.at(-1)!
    assert.strictEqual(turn.sessionId, reply.body.result?.conversationId)
    assert.match(turn.text, /^Resuma o evento em uma frase\./)
    assert.match(turn.text, /"ref": "main"/)
    assert.match(turn.text, /x-github-event/)
    assert.ok(!turn.text.includes(secret), 'a chave nunca chega ao agente')
    const owner = sessions.get(turn.sessionId)?.metadata?.owner as { id?: string }
    assert.strictEqual(owner?.id, 'u_root')

    const deliveries = (await admin('GET', `/agents/${CLAUDE_TEST_AGENT.id}/hooks/deploy/deliveries`)).body.result
    assert.deepStrictEqual([deliveries[0].status, deliveries[0].sessionId], ['ok', turn.sessionId])
  })

  it('⛔ chave errada ou ausente: 401; hook desligado ou inexistente: 404; trocar a chave derruba a antiga', async () => {
    assert.strictEqual((await fire('deploy', '{}', { 'X-Hook-Key': 'whk_errada' })).status, 401)
    assert.strictEqual((await fire('deploy', '{}', {})).status, 401)
    assert.strictEqual((await fire('nao-existe', '{}', { 'X-Hook-Key': 'x' })).status, 404)

    const rotated = (await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks/deploy/rotate`)).body.result.secret as string
    assert.strictEqual((await fire('deploy', '{}', { 'X-Hook-Key': rotated })).status, 202)
    await admin('PUT', `/agents/${CLAUDE_TEST_AGENT.id}/hooks/deploy`, { enabled: false })
    assert.strictEqual((await fire('deploy', '{}', { 'X-Hook-Key': rotated })).status, 404)
  })

  it('HMAC: a assinatura do corpo CRU (estilo GitHub) passa; errada ou de outro corpo, 401', async () => {
    const secret = (await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`, { name: 'github', prompt: 'Revise o push.', verify: 'hmac' })).body.result.secret as string
    const body = '{"ref":  "main"}'
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    assert.strictEqual((await fire('github', body, { 'X-Hub-Signature-256': signature })).status, 202)
    assert.strictEqual((await fire('github', '{"ref":"main"}', { 'X-Hub-Signature-256': signature })).status, 401, 'o mesmo JSON com outros bytes não confere')
    assert.strictEqual((await fire('github', body, { Authorization: `Bearer ${secret}` })).status, 401, 'no HMAC, a chave sozinha não basta')
    await settle(3)
    assert.ok(!received.at(-1)!.text.includes(signature), 'a assinatura não vai para o agente')
  })

  it('`new`: duas chamadas, duas conversas; `continuous`: a mesma conversa, um turno depois do outro', async () => {
    const before = sessions.size
    const fresh = (await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`, { name: 'cada-um', prompt: 'p' })).body.result.secret as string
    const [a, b] = await Promise.all([fire('cada-um', '{}', { 'X-Hook-Key': fresh }), fire('cada-um', '{}', { 'X-Hook-Key': fresh })])
    assert.notStrictEqual(a.body.result?.conversationId, b.body.result?.conversationId)
    assert.strictEqual(sessions.size, before + 2)

    turnDelay = 150
    const continuous = (await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`, { name: 'fila', prompt: 'p', session: 'continuous' })).body.result.secret as string
    const [first, second] = await Promise.all([fire('fila', '{"n":1}', { 'X-Hook-Key': continuous }), fire('fila', '{"n":2}', { 'X-Hook-Key': continuous })])
    assert.deepStrictEqual([first.status, second.status], [202, 202])
    assert.strictEqual(first.body.result?.conversationId, second.body.result?.conversationId)
    const id = first.body.result!.conversationId
    for (let i = 0; i < 100 && received.filter((entry) => entry.sessionId === id && entry.done).length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    const turns = received.filter((entry) => entry.sessionId === id)
    assert.strictEqual(turns.length, 2)
    assert.ok(turns[1].at >= turns[0].done!, 'o segundo turno só começa quando o primeiro termina')
    turnDelay = 0
  })

  it('⛔ a conta do hook desativada: 409, e nada roda', async () => {
    const secret = (await admin('POST', `/agents/${CLAUDE_TEST_AGENT.id}/hooks`, { name: 'orfao', prompt: 'p' })).body.result.secret as string
    const hook = hooks.get(CLAUDE_TEST_AGENT.id, 'orfao')
    Object.assign(accounts, { [hook.runAs]: { ...accounts[hook.runAs], disabled: true } })
    try {
      const count = received.length
      const reply = await fire('orfao', '{}', { 'X-Hook-Key': secret })
      assert.deepStrictEqual([reply.status, reply.body.code], [409, 'hook_owner_inactive'])
      assert.strictEqual(received.length, count)
    } finally {
      accounts[hook.runAs].disabled = false
    }
  })

  it('⛔ o cadastro é só de admin (404 para os demais); apagar o agente apaga os hooks e as chaves', async () => {
    const anonymous = await fetch(`${base}/agents/${CLAUDE_TEST_AGENT.id}/hooks`)
    assert.ok([401, 404].includes(anonymous.status))
    hooks.removeAgent(CLAUDE_TEST_AGENT.id)
    assert.deepStrictEqual(hooks.list(CLAUDE_TEST_AGENT.id), [])
    assert.strictEqual(hooks.secretOf(CLAUDE_TEST_AGENT.id, 'deploy'), undefined)
  })
})
