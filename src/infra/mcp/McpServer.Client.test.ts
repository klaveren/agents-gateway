import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { BASE_RETRY_MS, MAX_RETRY_MS, McpServerClient } from './McpServer.Client'

interface IFakeClientLog {
  connects: number
  closed: boolean
}

/**
 * O cliente real é substituído por inteiro: nenhum teste aqui abre socket, e por isso a
 * suíte não depende de haver um MCP server no ar.
 */
function fakeClient(behaviour: Partial<Client>, log: IFakeClientLog): Client {
  return {
    async connect() {
      log.connects += 1
    },
    async close() {
      log.closed = true
    },
    ...behaviour,
  } as unknown as Client
}

describe('McpServerClient', () => {
  const emptyLog = (): IFakeClientLog => ({ connects: 0, closed: false })

  const refusingClient = () =>
    ({
      async connect() {
        throw new Error('ECONNREFUSED')
      },
    }) as unknown as Client

  it('starts disconnected and lists nothing when nothing answers', async () => {
    const client = new McpServerClient('http://localhost:8000/mcp', { createClient: refusingClient })

    assert.strictEqual(client.isConnected(), false)
    assert.deepStrictEqual(await client.listTools(), [])
    assert.strictEqual(client.isConnected(), false)
  })

  it('connects and maps the server tools into the gateway shape', async () => {
    const log = emptyLog()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () =>
        fakeClient(
          {
            listTools: async () => ({
              tools: [
                {
                  name: 'read_file',
                  description: 'Reads a file',
                  inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'p' } }, required: ['path'] },
                },
              ],
            }),
          },
          log,
        ),
    })

    assert.strictEqual(await client.connect(), true)
    assert.strictEqual(client.isConnected(), true)

    const tools = await client.listTools()
    assert.strictEqual(tools.length, 1)
    assert.strictEqual(tools[0].name, 'read_file')
    assert.strictEqual(tools[0].origin, 'mcp')
    assert.deepStrictEqual(tools[0].inputSchema.required, ['path'])
  })

  it('reports failure instead of throwing when nothing answers', async () => {
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () =>
        ({
          async connect() {
            throw new Error('ECONNREFUSED')
          },
        }) as unknown as Client,
    })

    assert.strictEqual(await client.connect(), false)
    assert.strictEqual(client.isConnected(), false)
  })

  it('falls back to the SSE transport when streamable HTTP is refused', async () => {
    const log = emptyLog()
    let attempt = 0

    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => {
        attempt += 1
        if (attempt === 1) {
          return {
            async connect() {
              throw new Error('405 Method Not Allowed')
            },
          } as unknown as Client
        }
        return fakeClient({ listTools: async () => ({ tools: [] }) }, log)
      },
    })

    assert.strictEqual(await client.connect(), true)
    assert.strictEqual(attempt, 2)
  })

  it('returns tool text and flags server-side errors', async () => {
    const log = emptyLog()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () =>
        fakeClient(
          {
            callTool: async ({ name }) =>
              name === 'boom'
                ? { content: [{ type: 'text', text: 'it blew up' }], isError: true }
                : {
                    content: [
                      { type: 'text', text: 'hello' },
                      { type: 'image', data: 'x', mimeType: 'image/png' },
                    ],
                  },
          },
          log,
        ),
    })

    await client.connect()

    assert.deepStrictEqual(await client.callTool('greet', {}), { status: 'success', result: 'hello' })
    assert.deepStrictEqual(await client.callTool('boom', {}), { status: 'error', result: 'it blew up' })
  })

  it('refuses to call a tool while disconnected', async () => {
    const client = new McpServerClient('http://localhost:8000/mcp', { createClient: refusingClient })
    const outcome = await client.callTool('read_file', {})

    assert.strictEqual(outcome.status, 'error')
    assert.match(outcome.result, /MCP server unavailable/)
  })

  it('drops the connection when listing fails mid-flight', async () => {
    const log = emptyLog()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () =>
        fakeClient(
          {
            listTools: async () => {
              throw new Error('socket hang up')
            },
          },
          log,
        ),
    })

    await client.connect()
    assert.deepStrictEqual(await client.listTools(), [])
    assert.strictEqual(client.isConnected(), false)
  })

  it('closes the underlying client', async () => {
    const log = emptyLog()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => fakeClient({ listTools: async () => ({ tools: [] }) }, log),
    })

    await client.connect()
    await client.close()

    assert.strictEqual(log.closed, true)
    assert.strictEqual(client.isConnected(), false)
  })
})

describe('McpServerClient reconnection', () => {
  /** Relógio controlado: o teste não dorme esperando o backoff. */
  const clock = () => {
    let current = 0
    return { now: () => current, advance: (ms: number) => (current += ms) }
  }

  const flakyClient = (state: { up: boolean; listed: number }): Client =>
    ({
      async connect() {
        if (!state.up) throw new Error('ECONNREFUSED')
      },
      async close() {},
      async listTools() {
        state.listed += 1
        if (!state.up) throw new Error('socket hang up')
        return { tools: [] }
      },
    }) as unknown as Client

  it('picks up an MCP server that only comes up after boot', async () => {
    const state = { up: false, listed: 0 }
    const time = clock()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => flakyClient(state),
      now: time.now,
    })

    assert.strictEqual(await client.connect(), false)
    assert.strictEqual(client.isConnected(), false)

    // O server sobe depois. Sem esperar o backoff, ainda não tenta.
    state.up = true
    assert.strictEqual(await client.ensureConnected(), false)

    time.advance(BASE_RETRY_MS)
    assert.strictEqual(await client.ensureConnected(), true)
    assert.strictEqual(client.isConnected(), true)
  })

  it('backs off exponentially instead of hammering a server that is down', async () => {
    const state = { up: false, listed: 0 }
    const time = clock()
    let attempts = 0
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => {
        attempts += 1
        return flakyClient(state)
      },
      now: time.now,
    })

    // Cada tentativa custa dois handshakes: streamable HTTP e o fallback SSE.
    await client.connect()
    assert.strictEqual(attempts, 2)

    await client.ensureConnected()
    assert.strictEqual(attempts, 2, 'não deve tentar dentro da janela de backoff')

    time.advance(BASE_RETRY_MS)
    await client.ensureConnected()
    assert.strictEqual(attempts, 4)

    // A janela dobrou, então o mesmo avanço de antes já não basta.
    time.advance(BASE_RETRY_MS)
    await client.ensureConnected()
    assert.strictEqual(attempts, 4)

    time.advance(BASE_RETRY_MS)
    await client.ensureConnected()
    assert.strictEqual(attempts, 6)
  })

  it('caps the backoff', async () => {
    const state = { up: false, listed: 0 }
    const time = clock()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => flakyClient(state),
      now: time.now,
    })

    for (let round = 0; round < 20; round += 1) {
      await client.ensureConnected()
      time.advance(MAX_RETRY_MS)
    }

    state.up = true
    assert.strictEqual(await client.ensureConnected(), true)
  })

  it('drops the connection when a call fails and recovers on the next window', async () => {
    const state = { up: true, listed: 0 }
    const time = clock()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => flakyClient(state),
      now: time.now,
    })

    await client.connect()
    assert.strictEqual(client.isConnected(), true)

    state.up = false
    assert.deepStrictEqual(await client.listTools(), [])
    assert.strictEqual(client.isConnected(), false)

    state.up = true
    time.advance(BASE_RETRY_MS)
    assert.deepStrictEqual(await client.listTools(), [])
    assert.strictEqual(client.isConnected(), true)
  })

  it('bumps the generation on every successful connect so cached servers can expire', async () => {
    const state = { up: true, listed: 0 }
    const time = clock()
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => flakyClient(state),
      now: time.now,
    })

    assert.strictEqual(client.connectionGeneration, 0)

    await client.connect()
    const first = client.connectionGeneration
    assert.strictEqual(first, 1)

    state.up = false
    await client.listTools()
    state.up = true
    time.advance(BASE_RETRY_MS)
    await client.ensureConnected()

    assert.strictEqual(client.connectionGeneration, first + 1)
  })

  it('shares one handshake between concurrent callers', async () => {
    const state = { up: true, listed: 0 }
    let attempts = 0
    const client = new McpServerClient('http://localhost:8000/mcp', {
      createClient: () => {
        attempts += 1
        return flakyClient(state)
      },
      now: clock().now,
    })

    await Promise.all([client.ensureConnected(), client.ensureConnected(), client.ensureConnected()])

    assert.strictEqual(attempts, 1)
  })
})

describe('McpServerClient resource hygiene', () => {
  it('does not leak a handle for every failed attempt', async () => {
    // O backoff tenta para sempre. Transporte que falhou e não é fechado segura timer de
    // reconexão, então cada tentativa acumulava um handle no processo.
    const client = new McpServerClient('http://127.0.0.1:1/mcp')

    const before = process.getActiveResourcesInfo().length
    for (let attempt = 0; attempt < 3; attempt += 1) await client.connect()
    const after = process.getActiveResourcesInfo().length

    assert.strictEqual(after, before, 'tentativa falha deixou handle vivo')
  })
})
