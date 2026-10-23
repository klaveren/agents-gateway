import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuthController, makeController, makeMcpServersController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('guia MCPs (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let member = ''
  let pat = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text) as { result?: any; code?: string } } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  before(async () => {
    process.env.MCP_SERVER_URL = ''
    const controller = makeController()
    const server = new HttpServer(controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations), makeMcpServersController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }

    admin = (await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD } })).body.result.token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).body.result.token
    pat = (await call('/auth/tokens', { method: 'POST', token: admin, body: { name: 'mcp' } })).body.result.token
  })

  after(() => stop())

  it('⛔ só admin: membro recebe 404', async () => {
    assert.strictEqual((await call('/mcp-servers', { token: member })).status, 404)
    assert.strictEqual((await call('/mcp-servers', { method: 'POST', token: member, body: { id: 'x', name: 'x', url: 'https://x.com/mcp' } })).status, 404)
  })

  it('cadastra um MCP de verdade (o próprio gateway), testa e lista as ferramentas — sem nunca devolver o segredo', async () => {
    const created = await call('/mcp-servers', {
      method: 'POST',
      token: admin,
      body: { id: 'gw', name: 'O próprio gateway', url: `${base}/mcp`, transport: 'http', auth: 'header', headerName: 'X-Tool-Authorization', secret: `Bearer ${pat}` },
    })
    assert.strictEqual(created.status, 201)
    assert.strictEqual(created.body.result.selfReference, true)
    assert.ok(!created.text.includes(pat))

    const tested = await call('/mcp-servers/gw/test', { method: 'POST', token: admin })
    assert.strictEqual(tested.body.result.ok, true)
    assert.ok(tested.body.result.tools > 0)

    const tools = await call('/mcp-servers/gw/tools', { token: admin })
    assert.ok(tools.body.result.some((tool: { name: string }) => tool.name === 'list_agents'))

    const list = await call('/mcp-servers', { token: admin })
    assert.ok(!list.text.includes(pat))
    assert.strictEqual(list.body.result.find((entry: { id: string }) => entry.id === 'gw').secret.configured, true)
  })

  it('o agente escolhe ferramentas do servidor; servidor em uso não se apaga (409); servidor que não existe é recusado', async () => {
    const agent = {
      id: 'operador',
      name: 'Operador',
      provider: 'claude',
      systemPrompt: 'Você opera o gateway.',
      models: ['claude-sonnet-5'],
      modes: ['chat'],
      allowedTools: ['mcp:gw/list_agents'],
    }
    const created = await call('/agents', { method: 'POST', token: admin, body: agent })
    assert.strictEqual(created.status, 201, created.text)

    const removed = await call('/mcp-servers/gw', { method: 'DELETE', token: admin })
    assert.deepStrictEqual([removed.status, removed.body.code], [409, 'mcp_server_in_use'])

    const unknown = await call('/agents', { method: 'POST', token: admin, body: { ...agent, id: 'outro', allowedTools: ['mcp:nao-existe/x'] } })
    assert.strictEqual(unknown.status, 422)

    const listed = await call('/mcp-servers', { token: admin })
    assert.deepStrictEqual(
      listed.body.result.find((entry: { id: string }) => entry.id === 'gw').agents.map((entry: { id: string }) => entry.id),
      ['operador'],
    )
  })
})
