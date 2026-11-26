import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

/** "Manter conectado" de ponta a ponta: o cookie de 30 dias, a renovação pelo uso da tela e a lista de sessões. */
describe('"Manter conectado" (integração)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    // Renova já no pedido seguinte (o intervalo de 1 h, encolhido para o teste).
    process.env.AUTH_SESSION_RENEW_MINUTES = '0.0001'
    const server = new HttpServer(makeController(), makeAuthController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD }),
    })
    assert.strictEqual(setup.status, 201)
  })

  after(() => {
    delete process.env.AUTH_SESSION_RENEW_MINUTES
    stop()
  })

  const origin = () => `http://${new URL(base).host}`
  // O ÚLTIMO `Set-Cookie` do nome: é o que o navegador guarda (a renovação vem antes do que a rota grava).
  const jar = (res: Response, name = 'gw_session_') =>
    res.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith(name))
      .at(-1)
      ?.split(';')[0]
  const maxAge = (res: Response) => Number(/Max-Age=(\d+)/.exec(res.headers.getSetCookie().find((cookie) => cookie.startsWith('gw_session_')) ?? '')?.[1])
  const webLogin = (keepSignedIn?: boolean) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gateway-Client': 'web', Origin: origin(), 'User-Agent': IPHONE },
      body: JSON.stringify({ email: 'root@x.test', password: PASSWORD, ...(keepSignedIn === undefined ? {} : { keepSignedIn }) }),
    })
  const api = (path: string, cookie: string, init: { method?: string } = {}) =>
    fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { Cookie: cookie, Origin: origin() } })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1100))

  it('marcada: cookie de 30 dias (iPhone: sobrevive a fechar o app); desmarcada ou ausente: 12 h', async () => {
    const kept = await webLogin(true)
    assert.strictEqual(kept.status, 200)
    assert.ok(Math.abs(maxAge(kept) - 30 * 86_400) < 10, `Max-Age ${maxAge(kept)}`)
    assert.match(kept.headers.getSetCookie().join('\n'), /HttpOnly; SameSite=Strict/)
    const csrf = Number(/Max-Age=(\d+)/.exec(kept.headers.getSetCookie().find((cookie) => cookie.startsWith('gw_csrf_')) ?? '')?.[1])
    assert.ok(Math.abs(csrf - 30 * 86_400) < 10, 'o cookie do CSRF acompanha')

    assert.ok(Math.abs(maxAge(await webLogin(false)) - 12 * 3600) < 10)
    assert.ok(Math.abs(maxAge(await webLogin()) - 12 * 3600) < 10)
  })

  it('o uso pela tela renova o cookie; o cabeçalho e a sessão curta não renovam', async () => {
    const cookie = jar(await webLogin(true))!
    await tick()
    const used = await api('/auth/me', cookie)
    assert.strictEqual(used.status, 200)
    const renewed = jar(used)
    assert.ok(renewed && renewed !== cookie, 'cookie novo')
    assert.ok(Math.abs(maxAge(used) - 30 * 86_400) < 10)
    assert.strictEqual((await api('/auth/me', renewed)).status, 200)

    const token = decodeURIComponent(cookie.split('=')[1])
    await tick()
    const viaHeader = await fetch(`${base}/auth/me`, { headers: { 'X-Tool-Authorization': `Bearer ${token}` } })
    assert.strictEqual(viaHeader.status, 200)
    assert.strictEqual(jar(viaHeader), undefined)

    const short = jar(await webLogin(false))!
    await tick()
    assert.strictEqual(jar(await api('/auth/me', short)), undefined)
  })

  it('⛔ sessão encerrada não renova; sair encerra a sessão longa', async () => {
    const cookie = jar(await webLogin(true))!
    assert.strictEqual((await api('/auth/logout', cookie, { method: 'POST' })).status, 200)
    await tick()
    const after = await api('/auth/me', cookie)
    assert.strictEqual(after.status, 401)
    assert.strictEqual(jar(after), undefined)
  })

  it('a lista de sessões, encerrar uma e encerrar as outras; ⛔ token de acesso não gere sessões', async () => {
    const other = jar(await webLogin(true))!
    const here = jar(await webLogin(true))!

    const listed = (await (await api('/auth/sessions', here)).json()) as {
      result: Array<{ id: string; device: string; current: boolean; keepSignedIn: boolean; lastUsedAt: string }>
    }
    const current = listed.result.find((session) => session.current)
    assert.ok(current)
    assert.strictEqual(current.device, 'App · iPhone')
    assert.strictEqual(current.keepSignedIn, true)
    assert.strictEqual(listed.result.filter((session) => session.current).length, 1)
    assert.ok(!JSON.stringify(listed).includes(decodeURIComponent(here.split('=')[1])), 'o token nunca sai na lista')

    const otherId = ((await (await api('/auth/sessions', other)).json()) as typeof listed).result.find((session) => session.current)!.id
    assert.strictEqual((await api(`/auth/sessions/${otherId}`, here, { method: 'DELETE' })).status, 200)
    assert.strictEqual((await api('/auth/me', other)).status, 401)
    assert.strictEqual((await api('/auth/sessions/nao-existe', here, { method: 'DELETE' })).status, 404)

    const third = jar(await webLogin(true))!
    const ended = await api('/auth/sessions', here, { method: 'DELETE' })
    assert.strictEqual(ended.status, 200)
    const fresh = jar(ended)!
    assert.strictEqual((await api('/auth/me', third)).status, 401)
    assert.strictEqual((await api('/auth/me', fresh)).status, 200)
    const left = ((await (await api('/auth/sessions', fresh)).json()) as typeof listed).result
    assert.deepStrictEqual(
      left.map((session) => session.current),
      [true],
    )

    // Encerrar a própria pela lista: é sair (o cookie é limpo).
    const self = await api(`/auth/sessions/${left[0].id}`, fresh, { method: 'DELETE' })
    assert.strictEqual(self.status, 200)
    assert.match(self.headers.getSetCookie().join('\n'), /gw_session_\d+=; .*Max-Age=0/)
    assert.strictEqual((await api('/auth/me', fresh)).status, 401)

    const login = (await (
      await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'root@x.test', password: PASSWORD }) })
    ).json()) as { result: { token: string } }
    const created = (await (
      await fetch(`${base}/auth/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tool-Authorization': `Bearer ${login.result.token}` },
        body: JSON.stringify({ name: 'ci', expiresInDays: 30 }),
      })
    ).json()) as { result: { token: string } }
    const viaAgw = await fetch(`${base}/auth/sessions`, { headers: { 'X-Tool-Authorization': `Bearer ${created.result.token}` } })
    assert.strictEqual(viaAgw.status, 403)
  })
})
