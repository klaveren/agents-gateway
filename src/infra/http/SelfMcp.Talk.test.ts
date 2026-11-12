import assert from 'node:assert'
import { describe, it } from 'node:test'
import { registerConversationTools } from './SelfMcp.Controller'
import type { ISelfReply, TSelfApi } from './Self.Api'

type THandler = (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

/** O `talk` do MCP com uma API de mentira: guarda as chamadas e responde como a rota responderia. */
const talk = () => {
  const calls: string[] = []
  const api: TSelfApi = async (method, path, options) => {
    calls.push(`${method} ${path}${options?.body ? ` ${JSON.stringify(options.body)}` : ''}`)
    const answer = (result: unknown): ISelfReply => ({ ok: true, status: 200, result })
    if (method === 'POST' && path === '/sessions') return answer({ id: 'gw_novo' })
    if (method === 'POST' && path.endsWith('/turns')) return answer({ turn: 2 })
    if (method === 'GET' && path.includes('/turns/'))
      return answer({ conversationId: path.split('/')[2], turn: Number(path.split('/').at(-1)), status: 'ok', text: 'pronto', tools: [] })
    if (path === '/agents')
      return answer([
        { id: 'integra', name: 'Integra' },
        { id: 'off', unavailable: 'no model' },
      ])
    if (path === '/conversations') return answer({ sessions: [{ id: 'gw_1', agentId: 'integra', title: 'Notas' }] })
    return { ok: false, status: 404, message: 'not found' }
  }
  let handler: THandler | undefined
  registerConversationTools({ registerTool: ((name: string, _def: unknown, fn: THandler) => (assert.strictEqual(name, 'talk'), (handler = fn))) as never }, api, false)
  const run = async (args: Record<string, unknown>) => {
    const result = await handler!(args, {})
    return { ...(result.isError ? { isError: true } : {}), body: JSON.parse(result.content[0].text) }
  }
  return { run, calls }
}

describe('talk — a ferramenta de conversa do MCP do gateway (pessoa, integração)', () => {
  it('sem nada: os agentes que respondem e as conversas recentes', async () => {
    const { run } = talk()
    assert.deepStrictEqual((await run({})).body, { agents: [{ id: 'integra', name: 'Integra' }], conversations: [{ conversation: 'gw_1', to: 'integra', title: 'Notas' }] })
  })

  it('`to` + `message` abre e manda; `to` só abre; as opções de abrir vão juntas', async () => {
    const { run, calls } = talk()
    assert.deepStrictEqual((await run({ to: 'integra', message: 'oi', projectId: 'bh', model: 'm' })).body, {
      conversation: 'gw_novo',
      turn: 2,
      status: 'ok',
      text: 'pronto',
      tools: [],
    })
    assert.deepStrictEqual((await run({ to: 'integra' })).body, { conversation: 'gw_novo', to: 'integra' })
    assert.deepStrictEqual(calls.slice(0, 3), [
      'POST /sessions {"agentId":"integra","projectId":"bh","model":"m"}',
      'POST /sessions/gw_novo/turns {"message":"oi"}',
      'GET /sessions/gw_novo/turns/2',
    ])
  })

  it('`conversation` + `message` continua; `conversation` + `turn` acompanha', async () => {
    const { run, calls } = talk()
    assert.strictEqual((await run({ conversation: 'gw_1', message: 'de novo' })).body.conversation, 'gw_1')
    assert.strictEqual((await run({ conversation: 'gw_1', turn: 0 })).body.turn, 0)
    assert.deepStrictEqual(calls, ['POST /sessions/gw_1/turns {"message":"de novo"}', 'GET /sessions/gw_1/turns/2', 'GET /sessions/gw_1/turns/0'])
  })

  it('⛔ o pedido que não diz o que fazer é 422, sem chamar a API', async () => {
    const { run, calls } = talk()
    assert.deepStrictEqual(await run({ message: 'oi' }), {
      isError: true,
      body: { status: 422, code: 'validation_error', message: 'say who to talk to (`to`), or the conversation to continue (`conversation`)' },
    })
    assert.strictEqual((await run({ conversation: 'gw_1' })).isError, true)
    assert.deepStrictEqual(calls, [])
  })
})
