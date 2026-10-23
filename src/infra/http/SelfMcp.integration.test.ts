import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { makeAuth } from '@composition/factories/Auth.Factory'
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

    admin = (await call('/auth/setup', { method: 'POST', body: { code: makeAuth().accounts?.setupCode, email: 'root@x.test', name: 'Root', password: PASSWORD } })).result.token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = (await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).result.token
    // Um agente ATIVO para o membro ver (o Atlas): modelo no catálogo e ativado, e uma chave (de teste) no Claude.
    await call('/providers/claude/models', { method: 'POST', token: admin, body: { modelId: 'claude-sonnet-5' } })
    await call('/providers/claude/models', { method: 'PUT', token: admin, body: { modelId: 'claude-sonnet-5', enabled: true } })
    await call('/providers/claude/key', { method: 'PUT', token: admin, body: { key: 'sk-ant-teste-00000000' } })
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

  it('⛔ o membro só vê as ferramentas comuns; o admin vê as de admin e as de escrita (SELF_MCP_WRITE=0 desliga a escrita)', async () => {
    const common = ['get_conversation', 'list_agents', 'list_conversations', 'my_usage', 'send_message', 'start_conversation', 'switch_model']
    const adminRead = ['get_agent', 'list_models', 'list_providers', 'list_tools', 'usage_by_key']
    const write = ['save_agent', 'set_model_enabled', 'set_model_price']
    assert.deepStrictEqual(await names(member), common)
    assert.deepStrictEqual(await names(admin), [...common, ...adminRead, ...write].sort())

    process.env.SELF_MCP_WRITE = '0'
    try {
      assert.deepStrictEqual(await names(admin), [...common, ...adminRead].sort())
    } finally {
      delete process.env.SELF_MCP_WRITE
    }
  })

  it('set_model_price grava como preço manual; list_tools mostra locais, nativas e MCPs', async () => {
    const client = await connect(admin)
    const listed = await client.callTool({ name: 'list_models', arguments: { providerId: 'claude' } })
    const model = json(listed)[0]?.modelId ?? 'claude-sonnet-5'
    await client.callTool({ name: 'set_model_price', arguments: { providerId: 'claude', modelId: model, input: 1.5, output: 7.5 } })
    const after = json(await client.callTool({ name: 'list_models', arguments: { providerId: 'claude' } })).find((entry: { modelId: string }) => entry.modelId === model)
    assert.deepStrictEqual([after.price.input, after.price.output, after.priceSource], [1.5, 7.5, 'manual'])

    const tools = json(await client.callTool({ name: 'list_tools', arguments: {} }))
    assert.ok(Array.isArray(tools.local) && Array.isArray(tools.native) && Array.isArray(tools.mcp))
    assert.ok(tools.local.some((tool: { name: string }) => tool.name === 'run_bash'))
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
