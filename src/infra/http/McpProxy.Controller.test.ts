import assert from 'node:assert'
import { Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import { withCaller } from '@infra/mcp/Caller.Identity'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { McpProxyController } from './McpProxy.Controller'
import { TURN_GRANT_LOCAL } from './Security.Middleware'

const OWNER = { id: 'u1' }
/** Duas conversas da MESMA pessoa, cada uma com o seu agente e a sua instância do servidor. */
const SESSIONS: Record<string, { agentId: string; metadata: Record<string, unknown> }> = {
  c1: { agentId: 'a', metadata: { owner: OWNER } },
  c2: { agentId: 'b', metadata: { owner: OWNER } },
}

describe('McpProxyController — a ponte é da conversa do turno', () => {
  let server: Server
  let base: string

  /** O que a ponte devolve. `turn` = a conversa do turno que pediu (o que `Grant.Credential` deixa em `res.locals`). */
  const bridge = async (session: string, body: Record<string, unknown>, turn?: string) => {
    const res = await fetch(`${base}/mcp-proxy/srv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Gateway-Session': session, ...(turn ? { 'X-Test-Turn': turn } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any }
  }
  const list = (session: string, turn?: string) => bridge(session, { method: 'tools/list' }, turn)

  before(async () => {
    // A instância de cada conversa responde com o nome dela: dá para ver de QUAL conversa a resposta veio.
    const registry = {
      get: (key: string) => (key === 'srv' ? { id: 'srv', name: 'srv' } : undefined),
      clientFor: async (_key: string, sessionId?: string) => ({
        listToolsRaw: async () => [{ name: `de-${sessionId}`, inputSchema: { type: 'object' } }],
        callToolRaw: async (name: string) => ({ content: [{ type: 'text', text: `${sessionId}:${name}` }] }),
      }),
    } as unknown as McpRegistry
    const controller = new McpProxyController({
      registry,
      proof: { prove: async () => true },
      session: (id) => SESSIONS[id],
      agent: () => ({ allowedTools: ['mcp:srv/*'] }),
    })
    const app = express()
    app.use(express.json())
    app.post('/mcp-proxy/:serverId', (req, res) => {
      const turn = req.headers['x-test-turn']
      if (typeof turn === 'string') res.locals[TURN_GRANT_LOCAL] = { token: 'dona', sessionId: turn, agentId: SESSIONS[turn]?.agentId }
      void withCaller({ token: 'dona', id: OWNER.id }, () => controller.handle(req, res))
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(() => {
    server.closeAllConnections()
    server.close()
  })

  it('o agente alcança a instância da conversa do próprio turno', async () => {
    const own = await list('c1', 'c1')
    assert.strictEqual(own.status, 200, JSON.stringify(own.body))
    assert.deepStrictEqual(
      own.body.result.tools.map((tool: { name: string }) => tool.name),
      ['de-c1'],
    )
    const called = await bridge('c1', { method: 'tools/call', params: { name: 'de-c1', arguments: {} } }, 'c1')
    assert.strictEqual(called.body.result.content[0].text, 'c1:de-c1')
  })

  it('⛔ com a concessão de um turno, a conversa é a do turno: outra conversa do mesmo dono, dita no cabeçalho, é 404', async () => {
    const other = await list('c2', 'c1')
    assert.strictEqual(other.status, 404, JSON.stringify(other.body))
    assert.strictEqual(other.body.error.message, 'Not found')
    const called = await bridge('c2', { method: 'tools/call', params: { name: 'de-c2', arguments: {} } }, 'c1')
    assert.strictEqual(called.status, 404, JSON.stringify(called.body))
  })

  it('sem concessão (a pessoa, com a credencial dela), vale a regra de dono: alcança as conversas dela', async () => {
    const mine = await list('c2')
    assert.strictEqual(mine.status, 200, JSON.stringify(mine.body))
    assert.deepStrictEqual(
      mine.body.result.tools.map((tool: { name: string }) => tool.name),
      ['de-c2'],
    )
  })

  it('a conversa de outra pessoa continua 404', async () => {
    SESSIONS.c3 = { agentId: 'a', metadata: { owner: { id: 'u2' } } }
    assert.strictEqual((await list('c3')).status, 404)
    assert.strictEqual((await list('nao-existe')).status, 404)
  })
})
