import assert from 'node:assert'
import { describe, it } from 'node:test'
import { PersonMessagesService } from '@application/PersonMessages.Service'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { SqlitePersonMessageRepository } from '@infra/persistence/Sqlite.PersonMessageRepository'
import { IReplyTurn, ReplyMirror } from './Reply.Mirror'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('ReplyMirror — a resposta pela caixa volta ao pedido certo', () => {
  const build = (last: IReplyTurn | undefined, answered = new Set<string>()) => {
    const events = new InMemoryConversationEvents()
    const copies: Array<[string, string?]> = []
    const mirror = new ReplyMirror({
      events,
      lastTurn: async () => last,
      mirror: (_c, _a, text, options) => {
        copies.push(options?.replyTo ? [text, options.replyTo] : [text])
        if (options?.replyTo) answered.add(options.replyTo)
      },
      answered: (_c, requestId) => answered.has(requestId),
      settleMs: 0,
      waitMs: 5000,
    })
    const idle = (sessionId: string) => events.publish({ type: 'conversation.idle', sessionId } as never)
    return { mirror, copies, idle }
  }

  it('⛔ doze respostas à conversa na fila do mesmo turno: UMA cópia quando a conversa para (antes, doze)', async () => {
    const { mirror, copies, idle } = build({ index: 7, text: 'o desfecho', notified: false })
    const waits = Array.from({ length: 12 }, () => (mirror.expect('c1'), mirror.whenIdle('c1', 'maya')))
    await tick()
    idle('c1')
    await Promise.all(waits)
    assert.deepStrictEqual(copies, [['o desfecho']])
  })

  it('🎯 N respostas a N pedidos na fila: cada pedido recebe o texto final uma vez; o que o agente respondeu com replyTo, nada', async () => {
    const answered = new Set<string>()
    const { mirror, copies, idle } = build({ index: 9, text: 'feito', notified: true }, answered)
    const waits = ['m_a', 'm_b', 'm_c'].map((id) => (mirror.expect('c1', id), mirror.whenIdle('c1', 'maya')))
    answered.add('m_b') // o agente respondeu a este com notify + replyTo
    await tick()
    idle('c1')
    await Promise.all(waits)
    assert.deepStrictEqual(copies, [
      ['feito', 'm_a'],
      ['feito', 'm_c'],
    ])
    // A espera seguinte (o mesmo turno) não preenche de novo.
    mirror.settle('c1', 'maya', { index: 9, text: 'feito', notified: true })
    assert.strictEqual(copies.length, 2)
  })

  it('o mesmo turno não volta duas vezes à conversa; o agente que escreveu com notify não ganha cópia na conversa', async () => {
    const same = build({ index: 3, text: 'x', notified: false })
    same.mirror.markMirrored('c1', 3)
    same.mirror.expect('c1')
    const wait = same.mirror.whenIdle('c1', 'maya')
    await tick()
    same.idle('c1')
    await wait
    assert.deepStrictEqual(same.copies, [])

    const notified = build({ index: 4, text: 'y', notified: true })
    notified.mirror.expect('c1')
    const other = notified.mirror.whenIdle('c1', 'maya')
    await tick()
    notified.idle('c1')
    await other
    assert.deepStrictEqual(notified.copies, [])
  })

  it('o turno que falhou: um aviso só (pedido novo), não uma cópia por pedido', () => {
    const { mirror, copies } = build(undefined)
    mirror.expect('c1', 'm_a')
    mirror.expect('c1', 'm_b')
    mirror.settle('c1', 'maya', { index: 2, text: '', notified: false, error: 'caiu' })
    assert.deepStrictEqual(copies, [['Não consegui responder: caiu']])
  })

  it('depois de uma cópia, uma resposta nova numa conversa que voltou a rodar espera o próximo turno', async () => {
    let index = 1
    const events = new InMemoryConversationEvents()
    const copies: string[] = []
    const mirror = new ReplyMirror({
      events,
      lastTurn: async () => ({ index, text: `turno ${index}`, notified: false }),
      mirror: (_c, _a, text) => copies.push(text),
      answered: () => false,
      settleMs: 0,
      waitMs: 5000,
    })
    const idle = () => events.publish({ type: 'conversation.idle', sessionId: 'c1' } as never)
    mirror.expect('c1')
    const first = mirror.whenIdle('c1', 'maya')
    await tick()
    idle()
    await first
    index = 2
    mirror.expect('c1')
    const second = mirror.whenIdle('c1', 'maya')
    await tick()
    idle()
    await second
    assert.deepStrictEqual(copies, ['turno 1', 'turno 2'])
  })

  it('🎯 de ponta a ponta com a caixa: três pedidos respondidos com a conversa rodando; o agente responde um; cada item fica com a SUA resposta, uma vez', async () => {
    const service = new PersonMessagesService({
      repository: new SqlitePersonMessageRepository(':memory:'),
      conversation: async () => ({ ownerId: 'u_ana' }),
      members: () => [],
      accounts: () => [{ id: 'u_ana', email: 'ana@x.test', name: 'Ana', role: 'member', disabled: false }],
    })
    for (const title of ['Subir?', 'Apagar?', 'Migrar?']) await service.send({ sessionId: 'c1', agentId: 'maya', to: 'owner', title, body: title, level: 'attention' })
    const events = new InMemoryConversationEvents()
    const mirror = new ReplyMirror({
      events,
      lastTurn: async () => ({ index: 5, text: 'Tudo certo por aqui.', notified: true }),
      mirror: (conversationId, agentId, text, options) => service.mirror(conversationId, agentId, text, options?.level ?? 'info', options?.replyTo),
      answered: (conversationId, requestId) => service.answeredAfterReply(conversationId, requestId),
      settleMs: 0,
      waitMs: 5000,
    })
    const requests = service.thread('u_ana', 'c1')
    const waits = requests.map((request, index) => {
      const reply = service.reply('u_ana', request.id, `resposta ${index}`, 'Ana')
      mirror.expect('c1', reply.requestId)
      return mirror.whenIdle('c1', 'maya')
    })
    await service.send({ sessionId: 'c1', agentId: 'maya', to: 'owner', body: 'Apaguei.', replyTo: requests[1].id })
    await tick()
    events.publish({ type: 'conversation.idle', sessionId: 'c1' } as never)
    await Promise.all(waits)
    assert.deepStrictEqual(
      requests.map((request) => service.thread('u_ana', request.id).map((message) => message.body)),
      [
        ['Subir?', 'resposta 0', 'Tudo certo por aqui.'],
        ['Apagar?', 'resposta 1', 'Apaguei.'],
        ['Migrar?', 'resposta 2', 'Tudo certo por aqui.'],
      ],
    )
  })
})
