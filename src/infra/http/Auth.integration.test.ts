import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
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

  it('⛔ setup sem o código do log (ou com outro) é recusado, mesmo vindo desta máquina', async () => {
    assert.strictEqual((await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD } })).status, 404)
    assert.strictEqual((await call('/auth/setup', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC', email: 'root@x.test', name: 'Root', password: PASSWORD } })).status, 404)
  })

  it('setup com o código cria o admin e já entra; a segunda vez é recusada', async () => {
    const out = await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })
    assert.strictEqual(out.status, 201)
    rootToken = out.body.result.token

    assert.strictEqual(
      (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'b@x.test', name: 'B', password: PASSWORD } })).status,
      404,
    )
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
  it('⛔ sair encerra a sessão NO SERVIDOR: uma cópia do token deixa de valer', async () => {
    await call('/users', { method: 'POST', token: rootToken, body: { email: 'caio@x.test', name: 'Caio', password: PASSWORD } })
    const login = async () => (await call('/auth/login', { method: 'POST', body: { email: 'caio@x.test', password: PASSWORD } })).body.result.token as string
    const first = await login()
    const copy = await login()

    assert.strictEqual((await call('/auth/logout', { method: 'POST', token: first })).status, 200)
    assert.strictEqual((await call('/auth/me', { token: first })).status, 401)
    assert.strictEqual((await call('/auth/me', { token: copy })).status, 401)
  })

  it('⛔ o admin encerra as sessões de outra conta', async () => {
    const token = (await call('/auth/login', { method: 'POST', body: { email: 'caio@x.test', password: PASSWORD } })).body.result.token
    const caio = (await call('/auth/me', { token })).body.result

    assert.strictEqual((await call(`/users/${caio.id}/sessions`, { method: 'DELETE', token: rootToken })).status, 200)
    assert.strictEqual((await call('/auth/me', { token })).status, 401)
  })

  it('trocar a senha: esta sessão continua com o token novo, as outras caem', async () => {
    const here = (await call('/auth/login', { method: 'POST', body: { email: 'caio@x.test', password: PASSWORD } })).body.result.token
    const elsewhere = (await call('/auth/login', { method: 'POST', body: { email: 'caio@x.test', password: PASSWORD } })).body.result.token

    const changed = await call('/auth/password', { method: 'PUT', token: here, body: { current: PASSWORD, password: 'outra frase longa' } })
    assert.strictEqual(changed.status, 200)

    assert.strictEqual((await call('/auth/me', { token: changed.body.result.token })).status, 200)
    assert.strictEqual((await call('/auth/me', { token: here })).status, 401)
    assert.strictEqual((await call('/auth/me', { token: elsewhere })).status, 401)
  })

  describe('⛔ sessão da tela em cookie HttpOnly', () => {
    const raw = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init)
    const host = () => new URL(base).host

    it('o login da tela grava o cookie (HttpOnly, SameSite=Strict) e NÃO devolve o token no corpo', async () => {
      const res = await raw('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': 'web', Origin: `http://${host()}` },
        body: JSON.stringify({ email: 'root@x.test', password: PASSWORD }),
      })
      const cookie = res.headers.get('set-cookie') ?? ''
      const body = (await res.json()) as { result: Record<string, unknown> }
      assert.strictEqual(res.status, 200)
      assert.match(cookie, /^gw_session_\d+=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/)
      assert.strictEqual(body.result.token, undefined)
      assert.ok(body.result.user)

      // O cookie sozinho abre a conta; um pedido que muda algo sem `Origin` desta origem é recusado.
      const jar = cookie.split(';')[0]
      assert.strictEqual((await raw('/auth/me', { headers: { Cookie: jar } })).status, 200)
      assert.strictEqual((await raw('/auth/logout', { method: 'POST', headers: { Cookie: jar } })).status, 403)
      assert.strictEqual((await raw('/auth/logout', { method: 'POST', headers: { Cookie: jar, Origin: 'https://evil.example' } })).status, 403)

      const out = await raw('/auth/logout', { method: 'POST', headers: { Cookie: jar, Origin: `http://${host()}` } })
      assert.strictEqual(out.status, 200)
      assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/)
      assert.strictEqual((await raw('/auth/me', { headers: { Cookie: jar } })).status, 401)
    })

    it('quem tinha o token no navegador migra para o cookie sem novo login; token de fora não vira cookie', async () => {
      const login = await call('/auth/login', { method: 'POST', body: { email: 'root@x.test', password: PASSWORD } })
      const moved = await raw('/auth/cookie', { method: 'POST', headers: { 'X-Tool-Authorization': `Bearer ${login.body.result.token}` } })
      assert.strictEqual(moved.status, 200)
      assert.match(moved.headers.get('set-cookie') ?? '', /HttpOnly/)
      assert.strictEqual((await raw('/auth/cookie', { method: 'POST' })).status, 401)
    })
  })
})
