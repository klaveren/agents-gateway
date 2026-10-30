import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { callbackAllowed, CALLBACK_SIGNATURE_HEADER, deliverCallback } from './Turn.Callbacks'

const env = { TURN_CALLBACK_HOSTS: 'localhost:4000, api.interna', TURN_CALLBACK_SECRET: 'segredo' }
const payload = { conversationId: 'c1', turn: 0, status: 'ok' as const, durationMs: 10 }

describe('Turn.Callbacks (o aviso de fim de turno)', () => {
  it('⛔ só para host listado, com segredo, sem usuário na URL', () => {
    assert.ok(callbackAllowed('http://localhost:4000/fim', env))
    assert.ok(callbackAllowed('https://api.interna/fim', env))
    for (const url of ['http://localhost:4001/fim', 'http://169.254.169.254/', 'http://u:p@localhost:4000/x', 'file:///etc/passwd', 'nao-e-url'])
      assert.ok(!callbackAllowed(url, env), url)
    assert.ok(!callbackAllowed('http://localhost:4000/fim', { TURN_CALLBACK_HOSTS: 'localhost:4000' }), 'sem segredo, nunca')
  })

  it('assina o corpo com HMAC-SHA256 e tenta de novo até 3 vezes', async () => {
    const seen: Array<{ body: string; signature: string | null }> = []
    let calls = 0
    const http = (async (_url: string, init: RequestInit) => {
      seen.push({ body: String(init.body), signature: new Headers(init.headers).get(CALLBACK_SIGNATURE_HEADER) })
      return new Response('', { status: ++calls < 3 ? 503 : 200 })
    }) as typeof fetch
    assert.strictEqual(await deliverCallback('http://localhost:4000/fim', payload, { env, http, wait: async () => undefined }), true)
    assert.strictEqual(seen.length, 3)
    assert.strictEqual(seen[0].signature, `sha256=${createHmac('sha256', 'segredo').update(seen[0].body).digest('hex')}`)
    assert.deepStrictEqual(JSON.parse(seen[0].body), payload)
    assert.strictEqual(await deliverCallback('http://fora.example/fim', payload, { env, http, wait: async () => undefined }), false)
    assert.strictEqual(seen.length, 3, 'host fora da lista nem é chamado')
  })
})
