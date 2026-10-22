import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuthController, makeController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

/**
 * Contas locais de ponta a ponta, no Express de verdade: setup, login, a porta de admin e a queda do
 * token de quem perde o papel. É montado que se vê a ordem dos portões e o endereço do socket.
 */
describe('contas locais (integração)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const server = new HttpServer(makeController(), makeAuthController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => stop())

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as { ok: boolean; code?: string; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  let rootToken = ''
  let anaToken = ''
  let anaId = ''

  it('o status pede setup enquanto não há conta', async () => {
    assert.deepStrictEqual((await call('/auth/status')).body.result, { localAccounts: true, setupRequired: true })
  })

  it('⛔ setup atrás de proxy (X-Forwarded-For) é recusado, mesmo vindo do loopback', async () => {
    const out = await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD }, headers: { 'X-Forwarded-For': '203.0.113.9' } })
    assert.strictEqual(out.status, 404)
  })

  it('setup do loopback cria o admin e já entra; a segunda vez é recusada', async () => {
    const out = await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD } })
    assert.strictEqual(out.status, 201)
    rootToken = out.body.result.token

    assert.strictEqual((await call('/auth/setup', { method: 'POST', body: { email: 'b@x.test', name: 'B', password: PASSWORD } })).status, 404)
    assert.strictEqual((await call('/auth/status')).body.result.setupRequired, false)
  })

  it('o token do setup abre as telas de admin', async () => {
    assert.strictEqual((await call('/settings', { token: rootToken })).status, 200)
    assert.strictEqual((await call('/auth/me', { token: rootToken })).body.result.email, 'root@x.test')
  })

  it('admin cria uma conta; ela entra, e não vê /users nem /settings', async () => {
    const created = await call('/users', { method: 'POST', token: rootToken, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    assert.strictEqual(created.status, 201)
    anaId = created.body.result.id

    const login = await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })
    assert.strictEqual(login.status, 200)
    anaToken = login.body.result.token

    assert.strictEqual((await call('/users', { token: anaToken })).status, 404)
    assert.strictEqual((await call('/settings', { token: anaToken })).status, 404)
  })

  it('login errado: 401 com o mesmo código para senha errada e e-mail que não existe', async () => {
    const wrong = await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: 'senha errada!!' } })
    const nobody = await call('/auth/login', { method: 'POST', body: { email: 'ninguem@x.test', password: PASSWORD } })

    assert.deepStrictEqual([wrong.status, wrong.body.code], [401, 'invalid_credentials'])
    assert.deepStrictEqual([nobody.status, nobody.body.code], [401, 'invalid_credentials'])
  })

  it('⛔ o último admin não se rebaixa (422)', async () => {
    const me = (await call('/auth/me', { token: rootToken })).body.result
    assert.strictEqual((await call(`/users/${me.id}`, { method: 'PUT', token: rootToken, body: { role: 'member' } })).status, 422)
  })

  it('⛔ tornar admin e depois tirar: o token antigo cai na hora, e o novo login volta como membro', async () => {
    assert.strictEqual((await call(`/users/${anaId}`, { method: 'PUT', token: rootToken, body: { role: 'admin' } })).status, 200)

    // O token da Ana diz `member` e a conta agora é `admin`: não bate, não vale mais.
    assert.strictEqual((await call('/auth/me', { token: anaToken })).status, 401)
    const promoted = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    assert.strictEqual((await call('/users', { token: promoted })).status, 200)

    assert.strictEqual((await call(`/users/${anaId}`, { method: 'PUT', token: rootToken, body: { role: 'member' } })).status, 200)
    // Rota de admin responde 404 a quem não passa — a mesma resposta de sempre, sem dizer por quê.
    assert.strictEqual((await call('/users', { token: promoted })).status, 404)
    assert.strictEqual((await call('/auth/me', { token: promoted })).status, 401)
  })

  it('⛔ conta desativada não entra, e o hash nunca sai na lista', async () => {
    assert.strictEqual((await call(`/users/${anaId}`, { method: 'PUT', token: rootToken, body: { disabled: true } })).status, 200)
    assert.strictEqual((await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).status, 401)

    const list = await call('/users', { token: rootToken })
    assert.ok(!JSON.stringify(list.body).includes('scrypt'))
  })

  it('⛔ token forjado com role admin (sem assinatura) não abre nada', async () => {
    const forged = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'agents-gateway', sub: 'x', email: 'x@x.test', role: 'admin', exp: 9e9 })).toString('base64url')}.assinatura`
    assert.strictEqual((await call('/settings', { token: forged })).status, 404)
    assert.strictEqual((await call('/auth/me', { token: forged })).status, 401)
  })
})
