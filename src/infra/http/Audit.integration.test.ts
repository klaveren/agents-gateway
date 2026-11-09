import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController } from '@composition/factories/Controller.Factory'
import { SqliteAuditRepository } from '@infra/persistence/Sqlite.AuditRepository'
import { AuditController } from './Audit.Controller'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

/** A auditoria de ponta a ponta: o que muda algo vira evento (sem o corpo), e só quem administra o gateway lê. */
describe('auditoria (integração)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const audit = new AuditController({ repository: new SqliteAuditRepository(), proof: makeAuth().proof })
    const u = undefined
    const server = new HttpServer(makeController(), makeAuthController(), u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, u, audit).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => stop())

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  // O registro é gravado no `finish` da resposta: a próxima leitura pode chegar antes dele.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  it('grava setup, login errado, conta criada e configuração; sem senha no registro; só o admin lê', async () => {
    const root = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result
      .token
    assert.strictEqual((await call('/auth/login', { method: 'POST', body: { email: 'Ana@X.test', password: 'senha errada demais' } })).status, 401)
    const ana = await call('/users', { method: 'POST', token: root, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    assert.strictEqual(ana.status, 201)
    await call('/settings', { method: 'PUT', token: root, body: { audience: 'all' } })
    await call('/settings', { token: root })
    await settle()

    const listed = await call('/audit', { token: root })
    assert.strictEqual(listed.status, 200)
    const events = listed.body.result.events as Array<{ action: string; status: number; actorEmail?: string; detail?: string; target?: Record<string, string> }>
    const actions = events.map((event) => `${event.action} ${event.status}`)
    assert.deepStrictEqual(actions, ['PUT /settings 200', 'POST /users 201', 'POST /auth/login 401', 'POST /auth/setup 201'])
    assert.strictEqual(events.find((event) => event.action === 'POST /auth/login')?.detail, 'ana@x.test')
    assert.strictEqual(events[0].actorEmail, 'root@x.test')
    assert.ok(!JSON.stringify(events).includes(PASSWORD) && !JSON.stringify(events).includes('senha errada'))

    // Os filtros: só as falhas; por quem.
    assert.deepStrictEqual(
      (await call('/audit?failed=1', { token: root })).body.result.events.map((event: { action: string }) => event.action),
      ['POST /auth/login'],
    )
    assert.strictEqual((await call('/audit?actor=ana%40x', { token: root })).body.result.events.length, 1)

    const anaToken = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    assert.strictEqual((await call('/audit', { token: anaToken })).status, 404)
  })
})
