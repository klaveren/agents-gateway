import assert from 'node:assert'
import { Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import express from 'express'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { TurnGrants } from '@infra/tools/Turn.Grants'
import { TurnToolsController } from './TurnTools.Controller'

describe('TurnTools.Controller', () => {
  const grants = new TurnGrants()
  let server: Server
  let url = ''
  before(async () => {
    const app = express()
    app.use(express.json())
    app.post('/v1/turn-tools', new TurnToolsController(grants).handle)
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/turn-tools`
  })
  after(() => server.close())

  const connect = async (grant: string) => {
    const client = new Client({ name: 'teste', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { 'X-Turn-Grant': grant } } }))
    return client
  }

  it('⛔ só as ferramentas da concessão, no contexto dela; acabou o turno, nada', async () => {
    const seen: Array<IExecutionContext | undefined> = []
    const tool = (name: string, status: 'success' | 'error' = 'success') => ({
      origin: 'local' as const,
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: [], additionalProperties: false as const },
      execute: async (_args: Record<string, unknown>, context?: IExecutionContext) => (seen.push(context), { status, result: `${name} rodou` }),
    })
    const token = grants.register({ tools: [tool('run_bash'), tool('read_file', 'error')], context: { agentId: 'dev', sessionId: 's1', projectId: 'xpto' } })
    const client = await connect(token)

    assert.deepStrictEqual(
      (await client.listTools()).tools.map((item) => item.name),
      ['run_bash', 'read_file'],
    )
    const ran = await client.callTool({ name: 'run_bash', arguments: { command: 'ls' } })
    assert.deepStrictEqual([ran.isError, (ran.content as Array<{ text: string }>)[0].text], [undefined, 'run_bash rodou'])
    assert.strictEqual((await client.callTool({ name: 'read_file', arguments: {} })).isError, true)
    assert.strictEqual((await client.callTool({ name: 'write_file', arguments: {} })).isError, true)
    assert.deepStrictEqual(seen, [
      { agentId: 'dev', sessionId: 's1', projectId: 'xpto' },
      { agentId: 'dev', sessionId: 's1', projectId: 'xpto' },
    ])
    await client.close()

    grants.release(token)
    await assert.rejects(connect(token))
    await assert.rejects(connect('inventado'))
  })
})
