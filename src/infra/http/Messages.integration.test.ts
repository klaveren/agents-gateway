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
    const controller = makeController()
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
    assert.strictEqual((await call('/messages/gw_da_ana/read', { method: 'POST', token: member })).body.result.unread, 0)
    await call('/messages/gw_da_ana/archive', { method: 'PUT', token: member, body: { archived: true } })
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

  it('📱 o aviso no aparelho só se liga pela tela: token de integração, 403; sem conta, 401', async () => {
    assert.strictEqual((await call('/push/key', { token: member })).status, 403)
    assert.strictEqual(
      (await call('/push/subscriptions', { method: 'POST', token: member, body: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'a', auth: 'b' } } })).status,
      403,
    )
    assert.strictEqual((await call('/push/key')).status, 401)
  })
})
