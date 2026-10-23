import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAuth } from '@composition/factories/Auth.Factory'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('tokens de acesso (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let ana = ''
  let anaId = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, body: (await res.json()) as { result?: any } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  const mcpTools = async (token: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Tool-Authorization': `Bearer ${token}` } } }))
    return (await client.listTools()).tools.map((tool) => tool.name)
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
    anaId = (await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD, role: 'admin' } })).body.result.id
    ana = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
  })

  after(() => stop())

  it('o token de acesso vale como a conta na API e no MCP, e segue o papel dela', async () => {
    const created = await call('/auth/tokens', { method: 'POST', token: ana, body: { name: 'Claude Code', expiresInDays: 90 } })
    assert.strictEqual(created.status, 201)
    const pat = created.body.result.token as string
    assert.match(pat, /^agw_/)

    assert.strictEqual((await call('/auth/me', { token: pat })).body.result.email, 'ana@x.test')
    assert.ok((await mcpTools(pat)).includes('usage_by_key'))

    // Tirar o admin da conta rebaixa o token, sem mexer nele.
    await call(`/users/${anaId}`, { method: 'PUT', token: admin, body: { role: 'member' } })
    assert.ok(!(await mcpTools(pat)).includes('usage_by_key'))
    assert.ok((await mcpTools(pat)).includes('list_agents'))

    // A lista nunca devolve o token.
    const list = await call('/auth/tokens', { token: pat })
    assert.ok(!JSON.stringify(list.body).includes(pat))
  })

  it('⛔ "Sair" não derruba o token; revogado, 401; e token de acesso não cria nem revoga token', async () => {
    let session = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token as string
    const pat = (await call('/auth/tokens', { method: 'POST', token: session, body: { name: 'script' } })).body.result.token as string

    await call('/auth/logout', { method: 'POST', token: session })
    assert.strictEqual((await call('/auth/me', { token: session })).status, 401)
    assert.strictEqual((await call('/auth/me', { token: pat })).status, 200)

    assert.strictEqual((await call('/auth/tokens', { method: 'POST', token: pat, body: { name: 'filho' } })).status, 403)
    const id = (await call('/auth/tokens', { token: pat })).body.result.find((token: { name: string }) => token.name === 'script').id
    assert.strictEqual((await call(`/auth/tokens/${id}`, { method: 'DELETE', token: pat })).status, 403)

    session = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    assert.strictEqual((await call(`/auth/tokens/${id}`, { method: 'DELETE', token: session })).status, 200)
    assert.strictEqual((await call('/auth/me', { token: pat })).status, 401)
    assert.strictEqual((await call('/agents', { token: pat })).status, 401)
  })
})
