import assert from 'node:assert'
import { describe, it } from 'node:test'
import { Request, Response } from 'express'
import { CALLER_HEADER } from './Security.Middleware'
import { cookieCredential, csrfCookieName, csrfOf, sessionCookieName, setSessionCookie, viaSessionCookie } from './Session.Cookie'

const TOKEN = 'header.payload.assinatura'

/** Passa um pedido pelo `cookieCredential` e devolve o que a rota enxergaria. */
function run(headers: Record<string, string>, method = 'POST', secure = true) {
  const req = { method, secure, headers: { host: 'gw.test', cookie: `${sessionCookieName()}=${TOKEN}`, ...headers } } as unknown as Request
  const appended: string[] = []
  const res = { locals: {}, append: (_name: string, value: string) => appended.push(value), status: () => res, json: () => res } as unknown as Response
  let passed = false
  cookieCredential()(req, res, () => (passed = true))
  return { passed, onScreen: viaSessionCookie(res), caller: req.headers[CALLER_HEADER], appended }
}

const browser = { origin: 'http://gw.test', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-csrf': csrfOf(TOKEN) }

describe('Session.Cookie: o "só pela tela"', () => {
  it('a tela (origem, Sec-Fetch e o CSRF do cookie) é a pessoa no navegador', () => {
    const seen = run(browser)
    assert.deepStrictEqual([seen.passed, seen.onScreen, seen.caller], [true, true, `Bearer ${TOKEN}`])
  })

  it('⛔ o cookie forjado à mão (curl: Origin = Host) não é a tela: falta a prova do navegador', () => {
    assert.strictEqual(run({ origin: 'http://gw.test' }).onScreen, false)
    assert.strictEqual(run({ origin: 'http://gw.test', 'x-csrf': csrfOf(TOKEN) }).onScreen, false, 'HTTPS sem Sec-Fetch')
    assert.strictEqual(run({ ...browser, 'sec-fetch-site': 'cross-site' }).onScreen, false)
    assert.strictEqual(run({ ...browser, 'sec-fetch-site': 'none' }).onScreen, false)
    assert.strictEqual(run({ ...browser, 'sec-fetch-mode': 'navigate' }).onScreen, false)
  })

  it('em HTTP o navegador não manda Sec-Fetch: valem a origem e o CSRF do cookie (a tela da .4 não aprovava nada)', () => {
    const { 'sec-fetch-site': _site, 'sec-fetch-mode': _mode, ...plain } = browser
    void _site
    void _mode
    assert.strictEqual(run(plain, 'POST', false).onScreen, true)
    assert.strictEqual(run({ origin: 'http://gw.test' }, 'POST', false).onScreen, false, 'sem o CSRF')
    assert.strictEqual(run({ ...plain, 'x-csrf': csrfOf('outro.token.qualquer') }, 'POST', false).onScreen, false)
    assert.strictEqual(run({ ...plain, origin: 'http://outro.test' }, 'POST', false).onScreen, false)
    // Os Sec-Fetch que vierem seguem valendo, em HTTP também.
    assert.strictEqual(run({ ...browser, 'sec-fetch-site': 'cross-site' }, 'POST', false).onScreen, false)
  })

  it('⛔ sem o CSRF certo (derivado do token da sessão) também não', () => {
    assert.strictEqual(run({ ...browser, 'x-csrf': '' }).onScreen, false)
    assert.strictEqual(run({ ...browser, 'x-csrf': 'inventado' }).onScreen, false)
    assert.strictEqual(run({ ...browser, 'x-csrf': csrfOf('outro.token.qualquer') }).onScreen, false)
    const { 'x-csrf': _omitted, ...without } = browser
    void _omitted
    assert.strictEqual(run(without).onScreen, false)
  })

  it('a trava de origem de sempre segue: escrita com cookie de outra origem é 403', () => {
    assert.strictEqual(run({ ...browser, origin: 'https://evil.example' }).passed, false)
  })

  it('o cookie do CSRF nasce com a sessão, legível pelo JavaScript; o da sessão segue HttpOnly', () => {
    const appended: string[] = []
    setSessionCookie({ secure: false } as Request, { append: (_n: string, v: string) => appended.push(v) } as unknown as Response, {
      token: TOKEN,
      expiresAt: new Date(Date.now() + 3600_000),
    })
    const session = appended.find((line) => line.startsWith(`${sessionCookieName()}=`)) ?? ''
    const csrf = appended.find((line) => line.startsWith(`${csrfCookieName()}=`)) ?? ''
    assert.match(session, /HttpOnly/)
    assert.doesNotMatch(csrf, /HttpOnly/)
    assert.match(csrf, /SameSite=Strict/)
    assert.ok(csrf.startsWith(`${csrfCookieName()}=${encodeURIComponent(csrfOf(TOKEN))}`))
  })

  it('sessão que já existia antes do CSRF ganha o cookie dele no próximo pedido seguro', () => {
    const seen = run({}, 'GET')
    assert.ok(seen.appended.some((line) => line.startsWith(`${csrfCookieName()}=`)))
  })
})
