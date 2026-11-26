import assert from 'node:assert'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { SqliteCredentialStore } from '@infra/persistence/Sqlite.CredentialStore'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { MCP_MONITOR_DEFAULT_SECONDS, mcpMonitorMs, McpRegistry } from './Mcp.Registry'
import { duration, isSessionGone, McpServerClient } from './McpServer.Client'

/**
 * Um MCP de verdade, Streamable HTTP com sessão (como os do ambiente reativo): parar e subir de novo na mesma porta é o
 * "reiniciou a cada alteração" — o servidor novo não conhece a sessão antiga e responde 404 "Session not found".
 */
async function fakeMcp(port = 0) {
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const state = { calls: 0, fail: false }
  const http = createServer(async (req, res) => {
    // Sem stream GET: a sessão vive só nos POSTs (o teste não depende de reconexão de SSE).
    if (req.method !== 'POST') return void res.writeHead(405).end()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports.get(sessionId) : undefined
    if (!transport) {
      if (sessionId || !isInitializeRequest(body))
        return void res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }))
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => void transports.set(id, created),
      })
      transport = created
      const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }))
      server.setRequestHandler(CallToolRequestSchema, async () => {
        state.calls += 1
        if (state.fail) throw new Error('boom')
        return { content: [{ type: 'text', text: 'ok' }] }
      })
      await server.connect(transport)
    }
    await transport.handleRequest(req, res, body)
  })
  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve))
  return {
    port: (http.address() as AddressInfo).port,
    state,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections()
        http.close(() => resolve())
      }),
  }
}

/** As linhas de log do servidor `fx` (o monitor promete logar só as transições). */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const { log, warn } = console
  const keep =
    (original: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      const text = args.map(String).join(' ')
      if (text.startsWith('[mcp]')) lines.push(text)
      else original(...args)
    }
  console.log = keep(log)
  console.warn = keep(warn)
  return {
    lines,
    restore: () => {
      console.log = log
      console.warn = warn
    },
  }
}

describe('MCP: monitor e reconexão automática', () => {
  let logs: ReturnType<typeof captureLogs>
  beforeEach(() => {
    logs = captureLogs()
  })
  afterEach(() => logs.restore())

  it('⚖️ o servidor cai e volta: o monitor reconecta sozinho num ciclo, e o log só tem as transições', async () => {
    let mcp = await fakeMcp()
    const port = mcp.port
    const client = new McpServerClient(`http://127.0.0.1:${port}/mcp`, {}, { auth: 'none', transport: 'http', label: 'fx' })
    try {
      assert.strictEqual(await client.connect(), true)
      await mcp.stop()

      assert.strictEqual(await client.check(), false)
      assert.strictEqual(client.isConnected(), false)
      assert.ok(client.lastError, 'a tela de MCPs vê o motivo')
      // Mais ciclos com o servidor fora: nada novo no log.
      await client.check()
      await client.check()

      mcp = await fakeMcp(port)
      assert.strictEqual(await client.check(), true, 'voltou em um ciclo, sem ninguém usar')
      assert.strictEqual(client.isConnected(), true)
      assert.strictEqual(client.lastError, undefined)
      assert.deepStrictEqual((await client.callTool('echo', {})).status, 'success')

      const fx = logs.lines.filter((line) => line.includes(' fx '))
      assert.strictEqual(fx.length, 2, fx.join('\n'))
      assert.match(fx[0], /^\[mcp\] fx caiu: /)
      assert.match(fx[1], /^\[mcp\] fx voltou após \d+s$/)
    } finally {
      await client.close()
      await mcp.stop()
    }
  })

  it('⚖️ servidor reiniciado (sessão inválida): a chamada reconecta e é repetida UMA vez — e roda uma vez só', async () => {
    let mcp = await fakeMcp()
    const port = mcp.port
    const client = new McpServerClient(`http://127.0.0.1:${port}/mcp`, {}, { auth: 'none', transport: 'http', label: 'fx' })
    try {
      assert.strictEqual(await client.connect(), true)
      await mcp.stop()
      mcp = await fakeMcp(port)

      const result = await client.callTool('echo', {})
      assert.deepStrictEqual(result, { status: 'success', result: 'ok' })
      assert.strictEqual(mcp.state.calls, 1)
      assert.strictEqual(client.isConnected(), true)

      // Erro que não é de sessão: não se repete (a ferramenta pode já ter rodado).
      mcp.state.fail = true
      mcp.state.calls = 0
      const failed = await client.callTool('echo', {})
      assert.strictEqual(failed.status, 'error')
      assert.strictEqual(mcp.state.calls, 1)
    } finally {
      await client.close()
      await mcp.stop()
    }
  })

  it('⚖️ registro: o monitor recupera o remoto, a tela vê o estado ao vivo, e a conversa que viu a queda é avisada uma vez', async () => {
    let mcp = await fakeMcp()
    const port = mcp.port
    const servers = new SqliteMcpServerRepository(':memory:')
    const now = new Date()
    const config: IMcpServerConfig = {
      id: 'fx',
      name: 'Fixture',
      url: `http://127.0.0.1:${port}/mcp`,
      transport: 'http',
      auth: 'none',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    servers.insert(config)
    const registry = new McpRegistry(servers, new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'))
    try {
      await registry.connectAll()
      assert.strictEqual(registry.status()[0].connected, true)
      await mcp.stop()

      await registry.monitorTick()
      assert.strictEqual(registry.status()[0].connected, false)
      assert.ok(registry.status()[0].lastError)
      // A conversa viu a queda (uma ferramenta falhou, ou o aviso do começo do turno).
      registry.noteOutage('fx', 's1')
      registry.noteOutage('fx', 'probe:x')
      await registry.monitorTick()
      assert.deepStrictEqual(registry.takeRecovered('s1'), [], 'segue fora: nada a avisar')

      mcp = await fakeMcp(port)
      await registry.monitorTick()
      assert.strictEqual(registry.status()[0].connected, true)
      assert.deepStrictEqual(registry.takeRecovered('s1'), ['fx'])
      assert.deepStrictEqual(registry.takeRecovered('s1'), [], 'uma vez por volta')
      assert.deepStrictEqual(registry.takeRecovered('s2'), [], 'quem não viu a queda não é avisado')
    } finally {
      registry.forget('fx')
      await mcp.stop()
    }
  })

  it('o timer do monitor não segura o processo e para no shutdown; a cadência vem da variável', () => {
    const registry = new McpRegistry(new SqliteMcpServerRepository(':memory:'), new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:'))
    registry.startMonitor(1_000)
    registry.startMonitor(1_000)
    registry.stopMonitor()
    assert.strictEqual(mcpMonitorMs({}), MCP_MONITOR_DEFAULT_SECONDS * 1000)
    assert.strictEqual(mcpMonitorMs({ MCP_MONITOR_SECONDS: '15' }), 15_000)
    assert.strictEqual(mcpMonitorMs({ MCP_MONITOR_SECONDS: '0' }), 0)
    assert.strictEqual(mcpMonitorMs({ MCP_MONITOR_SECONDS: 'x' }), 60_000)
  })

  it('reconhece a sessão inválida pelo 404 e pelo texto; formata a duração do log', () => {
    assert.strictEqual(isSessionGone(new Error('Streamable HTTP error: Error POSTing to endpoint: {"error":{"message":"Session not found"}}')), true)
    assert.strictEqual(isSessionGone(new Error('Bad Request: No valid session ID provided')), true)
    assert.strictEqual(isSessionGone(new Error('fetch failed')), false)
    assert.deepStrictEqual([duration(4_000), duration(180_000), duration(3_900_000)], ['4s', '3min', '1h05'])
  })
})
