import assert from 'node:assert'
import { describe, it } from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServerClient } from './McpServer.Client'

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

  it('starts disconnected and lists nothing', async () => {
    const client = new McpServerClient('http://localhost:8000/mcp')

    assert.strictEqual(client.isConnected(), false)
    assert.deepStrictEqual(await client.listTools(), [])
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
    const client = new McpServerClient('http://localhost:8000/mcp')
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
