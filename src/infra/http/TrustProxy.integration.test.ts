import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController } from '@composition/factories/Controller.Factory'
import { trustProxyIssue } from './Security.Middleware'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('TRUST_PROXY — a validação', () => {
  it('aceita IP, CIDR e as faixas nomeadas; recusa o que confiaria em qualquer um', () => {
    for (const ok of ['10.42.0.0/16', '10.42.0.5', 'loopback', 'loopback, 10.0.0.0/8', 'fd00::/8', undefined, '']) assert.strictEqual(trustProxyIssue(ok), undefined, String(ok))
    for (const bad of ['true', '*', '2', '0.0.0.0/0', '::/0', 'meu-ingress']) assert.ok(trustProxyIssue(bad), bad)
  })
})

/** Um servidor real; `trust` liga o `TRUST_PROXY` (o teste, em 127.0.0.1, faz o papel do ingress). */
function serve(trust?: string) {
  if (trust) process.env.TRUST_PROXY = trust
  else delete process.env.TRUST_PROXY
  const server = new HttpServer(makeController(), makeAuthController()).start(0)
  delete process.env.TRUST_PROXY
  return {
    ready: new Promise((resolve) => server.once('listening', resolve)),
    base: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    stop: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

const login = (base: string, headers: Record<string, string>) =>
  fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email: 'ninguem@x.test', password: 'errada errada' }),
  })

describe('TRUST_PROXY — o IP real atrás do proxy', () => {
  const trusted = serve('loopback')
  const plain = serve()
  before(async () => {
    await Promise.all([trusted.ready, plain.ready])
    // Uma conta, para o login que confere o cookie `Secure`.
    await fetch(`${trusted.base()}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD }),
    })
  })
  after(() => {
    trusted.stop()
    plain.stop()
  })

  it('com proxy confiável, cada IP real tem o seu limite; o mesmo IP cai no 429', async () => {
    const distinct = await Promise.all(Array.from({ length: 21 }, (_, index) => login(trusted.base(), { 'X-Forwarded-For': `203.0.113.${index + 1}` }).then((res) => res.status)))
    assert.ok(!distinct.includes(429), String(distinct))

    const same: number[] = []
    for (let index = 0; index < 21; index++) same.push((await login(trusted.base(), { 'X-Forwarded-For': '198.51.100.7' })).status)
    assert.strictEqual(same.at(-1), 429)
  })

  it('⛔ sem TRUST_PROXY o `X-Forwarded-For` é ignorado: IP forjado não fura o limite', async () => {
    const forged: number[] = []
    for (let index = 0; index < 21; index++) forged.push((await login(plain.base(), { 'X-Forwarded-For': `192.0.2.${index + 1}` })).status)
    assert.strictEqual(forged.at(-1), 429)
  })

  it('o `X-Forwarded-Proto: https` do proxy confiável faz o cookie sair `Secure`', async () => {
    const res = await fetch(`${trusted.base()}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.200', 'X-Gateway-Client': 'web' },
      body: JSON.stringify({ email: 'root@x.test', password: PASSWORD }),
    })
    assert.strictEqual(res.status, 200)
    assert.match(res.headers.get('set-cookie') ?? '', /; Secure$/)
  })
})
