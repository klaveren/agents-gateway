import { egressPolicy } from '@infra/net/Guarded.Fetch'
import assert from 'node:assert'
import { createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { callbackAllowed, callbackSecret, CALLBACK_SIGNATURE_HEADER, deliverCallback } from './Turn.Callbacks'

const env = { TURN_CALLBACK_HOSTS: 'localhost:4000, api.interna', TURN_CALLBACK_SECRET: 'segredo' }
const payload = { conversationId: 'c1', turn: 0, status: 'ok' as const, durationMs: 10, agentId: 'theo', metadata: { epicCode: 'EP-1' }, at: '2026-11-05T16:00:00.000Z' }

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

  it('o segredo do projeto vale para o endereço dele, sem nada no ambiente; o da instalação fica de reserva', async () => {
    const project = (host: string) => (host === '10.10.0.4:4003' ? 'do-projeto' : undefined)
    assert.strictEqual(callbackSecret('http://10.10.0.4:4003/api/v1/gateway/turn-ended', project, {}), 'do-projeto')
    assert.strictEqual(callbackSecret('http://10.10.0.4:4004/fim', project, {}), undefined)
    assert.strictEqual(callbackSecret('http://localhost:4000/fim', project, env), 'segredo', 'a reserva da instalação')
    assert.strictEqual(callbackSecret('http://u:p@10.10.0.4:4003/fim', project, {}), undefined, 'sem credencial na URL')

    const seen: string[] = []
    const http = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get(CALLBACK_SIGNATURE_HEADER) ?? '')
      return new Response('', { status: 200 })
    }) as typeof fetch
    const url = 'http://10.10.0.4:4003/fim'
    assert.strictEqual(await deliverCallback(url, payload, { env: {}, http, secretFor: (target) => callbackSecret(target, project, {}) }), true)
    assert.strictEqual(seen[0], `sha256=${createHmac('sha256', 'do-projeto').update(JSON.stringify(payload)).digest('hex')}`)
  })
})

describe('Turn.Callbacks — destino interno (SSRF)', () => {
  it('⛔ o projeto não aponta o aviso para loopback, link-local ou metadado, nem por grafia estranha', () => {
    const project = () => 'do-projeto'
    for (const url of [
      'http://127.0.0.1:2375/x',
      'http://localhost:2375/x',
      'http://169.254.169.254/x',
      'http://[::ffff:7f00:1]:80/x',
      'http://[::ffff:a9fe:a9fe]/x',
      'http://2130706433/x',
      'http://0x7f.1/x',
      'http://0.0.0.0/x',
    ])
      assert.strictEqual(callbackSecret(url, project, {}), undefined, url)
    assert.strictEqual(callbackSecret('http://10.10.0.4:4003/x', project, {}), 'do-projeto', 'LAN cadastrada passa na validação; a ENTREGA confere o endereço')
  })

  it('o loopback listado na instalação (TURN_CALLBACK_HOSTS) continua valendo', () => {
    assert.strictEqual(
      callbackSecret('http://localhost:4000/fim', () => 'do-projeto', env),
      'do-projeto',
    )
  })

  it('⛔ a entrega recusa loopback não listado, sem conectar (nem a quem o projeto cadastrou); a rede local cadastrada passa', async () => {
    const policy = egressPolicy({ allowPrivate: false, allowLan: true, listed: () => false })
    assert.strictEqual(policy(new URL('http://10.10.0.4:4003/fim'), '10.10.0.4'), undefined, 'a LAN cadastrada')
    assert.ok(policy(new URL('http://127.0.0.1:2375/fim'), '127.0.0.1'), 'o loopback')
    assert.ok(policy(new URL('http://169.254.169.254/x'), '169.254.169.254'), 'o metadado')
    const quiet = console.warn
    console.warn = () => undefined
    try {
      for (const url of ['http://127.0.0.1:2375/fim', 'http://[::ffff:7f00:1]:2375/fim']) {
        assert.strictEqual(await deliverCallback(url, payload, { env: {}, secretFor: () => 'a'.repeat(40), wait: async () => undefined }), false, url)
      }
    } finally {
      console.warn = quiet
    }
  })
})
