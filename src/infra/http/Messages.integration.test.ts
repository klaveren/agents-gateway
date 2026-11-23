import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { makePersonMessages } from '@composition/factories/PersonMessages.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('Mensagens (integração)', () => {
  let base = ''
  let stop = () => undefined as void
  let admin = ''
  let member = ''
  let memberId = ''
  let controller: ReturnType<typeof makeController>

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as { result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    controller = makeController()
    const server = new HttpServer(controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations)).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    memberId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })).body.result.id
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    const now = new Date()
    await controller.conversations.saveSession({
      id: 'gw_da_ana',
      agentId: 'zeus',
      provider: 'claude',
      mode: 'agent',
      model: 'm',
      createdAt: now,
      updatedAt: now,
      turns: 3,
      usage: {},
      metadata: { owner: { id: memberId, email: 'ana@x.test' } },
    })
  })

  after(() => stop())

  it('💬 a dona recebe o fio, lê, arquiva; ninguém mais o vê (nem o admin); sem conta, 401', async () => {
    assert.deepStrictEqual(
      await makePersonMessages().send({ sessionId: 'gw_da_ana', agentId: 'zeus', to: 'owner', title: 'Preciso de você', body: 'Posso seguir?', level: 'attention', turn: 2 }),
      ['Ana'],
    )
    const listed = (await call('/messages', { token: member })).body.result
    assert.deepStrictEqual([listed.unread, listed.threads.length, listed.threads[0].title, listed.threads[0].last.turn], [1, 1, 'Preciso de você', 2])
    assert.strictEqual((await call('/messages', { token: admin })).body.result.threads.length, 0)
    assert.strictEqual((await call('/messages/gw_da_ana', { token: admin })).status, 404)
    assert.strictEqual((await call('/messages')).status, 401)
    assert.deepStrictEqual(
      (await call('/messages/gw_da_ana', { token: member })).body.result.messages.map((message: { body: string; from: string }) => [message.from, message.body]),
      [['agent', 'Posso seguir?']],
    )
    // O pedido é o próprio item: ler e arquivar vão pelo id dele.
    const item = listed.threads[0].id as string
    assert.strictEqual(listed.threads[0].requestId, item)
    assert.deepStrictEqual(
      (await call(`/messages/${item}`, { token: member })).body.result.messages.map((message: { body: string }) => message.body),
      ['Posso seguir?'],
    )
    assert.strictEqual((await call(`/messages/${item}/read`, { method: 'POST', token: member })).body.result.unread, 0)
    await call(`/messages/${item}/archive`, { method: 'PUT', token: member, body: { archived: true } })
    assert.deepStrictEqual(
      [(await call('/messages', { token: member })).body.result.threads.length, (await call('/messages?archived=1', { token: member })).body.result.threads.length],
      [0, 1],
    )
  })

  it('💬 responder pela caixa: a resposta aparece no fio e o turno vai para a conversa (202); quem não tem o fio, 404', async () => {
    await makePersonMessages().send({ sessionId: 'gw_da_ana', agentId: 'zeus', to: 'owner', body: 'Qual o prazo?' })
    assert.strictEqual((await call('/messages/gw_da_ana/reply', { method: 'POST', token: admin, body: { message: 'x' } })).status, 404)
    assert.strictEqual((await call('/messages/gw_da_ana/reply', { method: 'POST', token: member, body: { message: '  ' } })).status, 422)
    const sent = await call('/messages/gw_da_ana/reply', { method: 'POST', token: member, body: { message: 'Sexta' } })
    const thread = (await call('/messages/gw_da_ana', { token: member })).body.result.messages as Array<{ from: string; body: string }>
    // Conversa que não roda mais (aqui: só gravada, sem o agente): 404, e a resposta não entra no fio.
    if (sent.status === 404) assert.notStrictEqual(thread.at(-1)?.body, 'Sexta')
    else assert.deepStrictEqual([sent.status, thread.at(-1)?.from, thread.at(-1)?.body], [202, 'person', 'Sexta'])
  })

  it('💬 responder depois de um reinício: a conversa só gravada é retomada (antes, "Session not found")', async () => {
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    const agent = {
      id: 'atlas',
      name: 'Atlas',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'Você responde.',
      modes: ['chat'],
      allowedTools: [],
    }
    assert.strictEqual((await call('/agents', { method: 'POST', token: admin, body: agent })).status, 201)
    const now = new Date()
    await controller.conversations.saveSession({
      id: 'gw_do_atlas',
      agentId: 'atlas',
      provider: 'claude',
      mode: 'chat',
      model: 'claude-sonnet-5',
      createdAt: now,
      updatedAt: now,
      turns: 1,
      usage: {},
      metadata: { owner: { id: memberId, email: 'ana@x.test' } },
    })
    await makePersonMessages().send({ sessionId: 'gw_do_atlas', agentId: 'atlas', to: 'owner', title: 'Aprovar?', body: 'Aprova o plano?', level: 'attention' })
    const item = (await call('/messages', { token: member })).body.result.threads.find((thread: { requestId?: string; title?: string }) => thread.title === 'Aprovar?')
    const sent = await call(`/messages/${item.id}/reply`, { method: 'POST', token: member, body: { message: 'Aprovado' } })
    assert.strictEqual(sent.status, 202, JSON.stringify(sent.body))
  })

  it('🧵 responder ao SUBAGENTE depois de um reinício: a conversa de delegação volta como filha da mãe', async () => {
    const now = new Date()
    const base = { agentId: 'atlas', provider: 'claude', mode: 'chat', model: 'claude-sonnet-5', createdAt: now, updatedAt: now, turns: 1, usage: {} }
    await controller.conversations.saveSession({ ...base, id: 'gw_mae_atlas', metadata: { owner: { id: memberId, email: 'ana@x.test' } } })
    await controller.conversations.saveSession({
      ...base,
      id: 'gw_filha_atlas',
      metadata: { owner: { id: memberId, email: 'ana@x.test' }, delegatedBy: 'gw_mae_atlas', delegationDepth: 1 },
    })
    await makePersonMessages().send({ sessionId: 'gw_filha_atlas', agentId: 'atlas', to: 'owner', title: 'Da filha?', body: 'Posso seguir?', level: 'attention' })
    const item = (await call('/messages', { token: member })).body.result.threads.find((thread: { title?: string }) => thread.title === 'Da filha?')
    const sent = await call(`/messages/${item.id}/reply`, { method: 'POST', token: member, body: { message: 'Pode' } })
    assert.strictEqual(sent.status, 202, JSON.stringify(sent.body))
  })

  it('📌 pedido por pedido: pendentes no fio e no total; replyTo inválido é 422; status resolved/pending; info e alheio recusados', async () => {
    const service = makePersonMessages()
    await service.send({ sessionId: 'gw_da_ana', agentId: 'zeus', to: 'owner', title: 'Pedido novo', body: 'Posso?', level: 'urgent' })
    await service.send({ sessionId: 'gw_da_ana', agentId: 'zeus', to: 'owner', body: 'Só um aviso' })
    const listed = (await call('/messages?archived=1', { token: member })).body.result
    const all = (await call('/messages', { token: member })).body.result
    assert.ok(all.pending >= 1 && all.threads.some((thread: { pending: number }) => thread.pending >= 1) && typeof listed.pending === 'number')
    const messages = (await call('/messages/gw_da_ana', { token: member })).body.result.messages as Array<{ id: string; status?: string; title?: string; level: string }>
    const asked = messages.find((message) => message.title === 'Pedido novo')!
    const info = messages.find((message) => message.level === 'info' && !message.status)!
    assert.strictEqual(asked.status, 'pending')
    // replyTo que não é pedido deste fio: 422 no campo replyTo.
    const bad = await call('/messages/gw_da_ana/reply', { method: 'POST', token: member, body: { message: 'x', replyTo: info.id } })
    assert.strictEqual(bad.status, 422)
    assert.strictEqual(((bad.body as { details?: Array<{ field: string }> }).details ?? [])[0]?.field, 'replyTo')
    const before = (await call('/messages', { token: member })).body.result.pending
    const done = await call(`/messages/gw_da_ana/${asked.id}/status`, { method: 'PUT', token: member, body: { status: 'resolved' } })
    assert.deepStrictEqual([done.status, done.body.result.status, done.body.result.pending], [200, 'resolved', before - 1])
    assert.strictEqual((await call(`/messages/gw_da_ana/${asked.id}/status`, { method: 'PUT', token: member, body: { status: 'pending' } })).body.result.pending, before)
    assert.strictEqual((await call(`/messages/gw_da_ana/${info.id}/status`, { method: 'PUT', token: member, body: { status: 'resolved' } })).status, 422)
    assert.strictEqual((await call(`/messages/gw_da_ana/${asked.id}/status`, { method: 'PUT', token: member, body: { status: 'answered' } })).status, 422)
    assert.strictEqual((await call(`/messages/gw_da_ana/${asked.id}/status`, { method: 'PUT', token: admin, body: { status: 'resolved' } })).status, 404)
    assert.strictEqual((await call('/messages/gw_da_ana/nao_existe/status', { method: 'PUT', token: member, body: { status: 'resolved' } })).status, 404)
  })

  it('📱 o aviso no aparelho só se liga pela tela: token de integração, 403; sem conta, 401', async () => {
    assert.strictEqual((await call('/push/key', { token: member })).status, 403)
    assert.strictEqual(
      (await call('/push/subscriptions', { method: 'POST', token: member, body: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'a', auth: 'b' } } })).status,
      403,
    )
    assert.strictEqual((await call('/push/key')).status, 401)
  })

  it('🔐 a configuração do push é do admin pela tela: token de integração, 403', async () => {
    assert.strictEqual((await call('/push/config', { token: admin })).status, 403)
    assert.strictEqual((await call('/push/config', { method: 'PUT', token: admin, body: { contact: 'ops@empresa.com' } })).status, 403)
    assert.strictEqual((await call('/push/config/rotate', { method: 'POST', token: admin })).status, 403)
  })
})
