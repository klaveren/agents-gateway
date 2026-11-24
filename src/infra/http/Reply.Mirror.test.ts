import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { ReplyMirror } from './Reply.Mirror'

describe('ReplyMirror — a resposta pela caixa com a conversa rodando', () => {
  const build = (last: { index: number; text: string; notified: boolean } | undefined) => {
    const events = new InMemoryConversationEvents()
    const copies: string[] = []
    const mirror = new ReplyMirror({ events, lastTurn: async () => last, mirror: (_c, _a, text) => copies.push(text), settleMs: 0, waitMs: 5000 })
    const idle = (sessionId: string) => events.publish({ type: 'conversation.idle', sessionId } as never)
    return { mirror, copies, idle }
  }

  it('⛔ doze respostas na fila do mesmo turno: UMA cópia quando a conversa para (antes, doze)', async () => {
    const { mirror, copies, idle } = build({ index: 7, text: 'o desfecho', notified: false })
    const waits = Array.from({ length: 12 }, () => mirror.whenIdle('c1', 'maya'))
    await new Promise((resolve) => setImmediate(resolve))
    idle('c1')
    await Promise.all(waits)
    assert.deepStrictEqual(copies, ['o desfecho'])
  })

  it('o mesmo turno não volta duas vezes; o agente que já escreveu com notify não ganha cópia', async () => {
    const same = build({ index: 3, text: 'x', notified: false })
    same.mirror.markMirrored('c1', 3)
    const wait = same.mirror.whenIdle('c1', 'maya')
    await new Promise((resolve) => setImmediate(resolve))
    same.idle('c1')
    await wait
    assert.deepStrictEqual(same.copies, [])

    const notified = build({ index: 4, text: 'y', notified: true })
    const other = notified.mirror.whenIdle('c1', 'maya')
    await new Promise((resolve) => setImmediate(resolve))
    notified.idle('c1')
    await other
    assert.deepStrictEqual(notified.copies, [])
  })

  it('depois de uma cópia, uma resposta nova numa conversa que voltou a rodar espera o próximo turno', async () => {
    let index = 1
    const events = new InMemoryConversationEvents()
    const copies: string[] = []
    const mirror = new ReplyMirror({
      events,
      lastTurn: async () => ({ index, text: `turno ${index}`, notified: false }),
      mirror: (_c, _a, text) => copies.push(text),
      settleMs: 0,
      waitMs: 5000,
    })
    const idle = () => events.publish({ type: 'conversation.idle', sessionId: 'c1' } as never)
    const first = mirror.whenIdle('c1', 'maya')
    await new Promise((resolve) => setImmediate(resolve))
    idle()
    await first
    index = 2
    const second = mirror.whenIdle('c1', 'maya')
    await new Promise((resolve) => setImmediate(resolve))
    idle()
    await second
    assert.deepStrictEqual(copies, ['turno 1', 'turno 2'])
  })
})
