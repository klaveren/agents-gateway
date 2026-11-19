import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { SqlitePushSubscriptionRepository } from '@infra/persistence/Sqlite.PushSubscriptionRepository'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { PushError, TPushSend, WebPushSender } from './WebPush.Sender'

const KEYS = { p256dh: 'BPk', auth: 'aut' }
const APPLE = 'https://web.push.apple.com/QGx'

function build(send: TPushSend = async () => undefined) {
  const repository = new SqlitePushSubscriptionRepository(new SecretBox(randomBytes(32)))
  return { repository, push: new WebPushSender(repository, 'mailto:push@agents-gateway.invalid', send) }
}

describe('Web Push: o aviso de mensagem nova no aparelho', () => {
  it('o par VAPID nasce no primeiro uso, fica (a privada cifrada) e a pública é sempre a mesma', () => {
    const { repository, push } = build()
    const key = push.publicKey()
    assert.match(key, /^[A-Za-z0-9_-]{80,}$/)
    assert.strictEqual(push.publicKey(), key)
    assert.strictEqual(repository.vapid()?.publicKey, key)
  })

  it('só assina um serviço de push de verdade (https, Apple/Google/Mozilla/Microsoft): nada de rede interna', () => {
    const { push } = build()
    for (const endpoint of ['http://web.push.apple.com/x', 'https://10.10.0.4/x', 'https://evil.test/x', 'nada'])
      assert.throws(() => push.subscribe('u_ana', { endpoint, keys: KEYS }), PushError, endpoint)
    assert.throws(() => push.subscribe('u_ana', { endpoint: APPLE, keys: { p256dh: '', auth: 'x' } }), PushError)
    push.subscribe('u_ana', { endpoint: APPLE, keys: KEYS })
    push.subscribe('u_ana', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: KEYS })
    assert.strictEqual(push.devices('u_ana'), 2)
  })

  it('manda para todos os aparelhos da pessoa, o texto curto; a assinatura que acabou (410) é apagada', async () => {
    const sent: Array<{ endpoint: string; payload: string; subject: string }> = []
    const { push } = build(async (subscription, payload, vapid) => {
      sent.push({ endpoint: subscription.endpoint, payload, subject: vapid.subject })
      if (subscription.endpoint.includes('fcm')) throw Object.assign(new Error('gone'), { statusCode: 410 })
    })
    push.subscribe('u_ana', { endpoint: APPLE, keys: KEYS })
    push.subscribe('u_ana', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: KEYS })
    push.subscribe('u_bia', { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys: KEYS })
    await push.notify('u_ana', { title: 'Zeus: acesso', body: 'x'.repeat(500), url: '/messages/s1', tag: 'message:s1' })
    assert.strictEqual(sent.length, 2)
    const payload = JSON.parse(sent[0].payload) as { title: string; body: string; url: string }
    assert.strictEqual(payload.title, 'Zeus: acesso')
    assert.strictEqual(payload.url, '/messages/s1')
    assert.ok(payload.body.length <= 180)
    assert.strictEqual(sent[0].subject, 'mailto:push@agents-gateway.invalid')
    assert.strictEqual(push.devices('u_ana'), 1)
    assert.strictEqual(push.devices('u_bia'), 1)
  })

  it('desligar tira só o aparelho da própria pessoa', () => {
    const { push } = build()
    push.subscribe('u_ana', { endpoint: APPLE, keys: KEYS })
    push.unsubscribe('u_bia', APPLE)
    assert.strictEqual(push.devices('u_ana'), 1)
    push.unsubscribe('u_ana', APPLE)
    assert.strictEqual(push.devices('u_ana'), 0)
  })
})
