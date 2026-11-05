import assert from 'node:assert'
import { describe, it } from 'node:test'
import { awaitTurn, streamsTurn } from './SelfMcp.Controller'
import type { TSelfApi } from './Self.Api'

/** Um turno que fica `running` nas primeiras `runningFor` consultas e depois acaba. */
const turnApi = (runningFor: number): { api: TSelfApi; calls: () => number } => {
  let calls = 0
  const api: TSelfApi = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      result: { conversationId: 'c1', turn: 0, status: calls <= runningFor ? 'running' : 'ok', text: calls <= runningFor ? '' : 'pronto', tools: ['run_bash'] },
    }
  }
  return { api, calls: () => calls }
}

describe('a espera do turno no MCP do gateway', () => {
  it('em fluxo com progresso, espera até o fim e avisa enquanto roda', async () => {
    const { api } = turnApi(6)
    const seen: string[] = []
    const answer = await awaitTurn(api, 'c1', 0, undefined, {
      streaming: true,
      progressToken: 't',
      notify: async (_progress, message) => void seen.push(message),
      pollMs: 5,
      progressMs: 10,
    })
    assert.strictEqual((answer.result as { status: string }).status, 'ok')
    assert.ok(seen.length >= 1, 'avisou o progresso')
    assert.match(seen[0], /running for \d+ s · 1 tool calls, last: run_bash/)
  })

  it('em JSON, para no teto de 50 s e devolve running, como antes', async () => {
    const { api } = turnApi(Infinity)
    const answer = await awaitTurn(api, 'c1', 0, 0, { streaming: false, pollMs: 5 })
    assert.strictEqual((answer.result as { status: string }).status, 'running')
  })

  it('⛔ o cliente que desliga encerra a espera; o turno segue no servidor', async () => {
    const { api, calls } = turnApi(Infinity)
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 30)
    const answer = await awaitTurn(api, 'c1', 0, undefined, { streaming: true, progressToken: 't', signal: abort.signal, pollMs: 5 })
    assert.strictEqual((answer.result as { status: string }).status, 'running')
    assert.ok(calls() < 50, 'parou de consultar')
  })

  it('só a chamada que espera turno, de cliente que aceita SSE, vai em fluxo', () => {
    const sse = { accept: 'application/json, text/event-stream' }
    const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    for (const name of ['send_message', 'get_turn', 'start_conversation']) assert.strictEqual(streamsTurn({ headers: sse, body: call(name) }), true, name)
    assert.strictEqual(streamsTurn({ headers: sse, body: call('list_agents') }), false)
    assert.strictEqual(streamsTurn({ headers: { accept: 'application/json' }, body: call('send_message') }), false)
    assert.strictEqual(streamsTurn({ headers: sse, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }), false)
    assert.strictEqual(streamsTurn({ headers: sse, body: [call('send_message')] }), false)
  })
})
