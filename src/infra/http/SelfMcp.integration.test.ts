import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAuthController, makeController, makeProvidersController, makeUsageController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'

describe('MCP do próprio gateway (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let member = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return (await res.json()) as { result?: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  /** Um cliente MCP de verdade (o do SDK), com a conta no mesmo header da API. */
  const connect = async (token: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'X-Tool-Authorization': `Bearer ${token}` } } }))
    return client
  }
  const names = async (token: string) => (await (await connect(token)).listTools()).tools.map((tool) => tool.name).sort()
  const json = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    delete process.env.SELF_MCP_WRITE
    const controller = makeController()
    const server = new HttpServer(controller, makeAuthController(), makeProvidersController(), makeUsageController(controller.conversations)).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }

    admin = (await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD } })).result.token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).result.token
  })

  after(() => {
    delete process.env.SELF_MCP_WRITE
    stop()
  })

  it('sem conta, 401 — o MCP passa pelo mesmo portão da API', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{}' })
    assert.strictEqual(res.status, 401)
    assert.strictEqual((await fetch(`${base}/mcp`, { headers: { 'X-Tool-Authorization': `Bearer ${member}` } })).status, 405)
  })

  it('⛔ o membro só vê as ferramentas comuns; o admin vê as de admin, e as de escrita só com SELF_MCP_WRITE=1', async () => {
    const common = ['get_conversation', 'list_agents', 'list_conversations', 'my_usage', 'send_message', 'start_conversation', 'switch_model']
    assert.deepStrictEqual(await names(member), common)
    assert.deepStrictEqual(await names(admin), [...common, 'get_agent', 'list_models', 'list_providers', 'usage_by_key'].sort())

    process.env.SELF_MCP_WRITE = '1'
    try {
      assert.deepStrictEqual(await names(admin), [...common, 'get_agent', 'list_models', 'list_providers', 'save_agent', 'set_model_enabled', 'usage_by_key'].sort())
      assert.ok(!(await names(member)).includes('save_agent'))
    } finally {
      delete process.env.SELF_MCP_WRITE
    }
  })

  it('as ferramentas seguem as regras da API: agentes sem prompt, uso do membro sem custo, uso por chave para o admin', async () => {
    const asMember = await connect(member)
    const agents = json(await asMember.callTool({ name: 'list_agents', arguments: {} }))
    assert.ok(agents.length > 0)
    assert.ok(agents.every((agent: Record<string, unknown>) => !('systemPrompt' in agent)))

    const mine = await asMember.callTool({ name: 'my_usage', arguments: { days: 7 } })
    assert.ok(!/cost/i.test(JSON.stringify(mine)))

    const byKey = json(await (await connect(admin)).callTool({ name: 'usage_by_key', arguments: { key: 'accountId', days: 30 } }))
    assert.deepStrictEqual(byKey.groups, [])
  })

  it('erro da API vira isError com a mensagem, sem derrubar o cliente', async () => {
    const result = (await (await connect(member)).callTool({ name: 'start_conversation', arguments: { agentId: 'nao-existe' } })) as { isError?: boolean }
    assert.strictEqual(result.isError, true)
    assert.match(json(result).message, /nao-existe/)
  })
})
