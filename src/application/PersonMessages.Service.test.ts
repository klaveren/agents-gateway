import assert from 'node:assert'
import { describe, it } from 'node:test'
import { TConversationEvent } from '@domain/ports/ConversationEvents.Port'
import { SqlitePersonMessageRepository } from '@infra/persistence/Sqlite.PersonMessageRepository'
import { PersonMessageError, PersonMessagesService } from './PersonMessages.Service'

const ACCOUNTS = [
  { id: 'u_root', email: 'root@x.test', name: 'Root', role: 'admin', disabled: false },
  { id: 'u_ana', email: 'ana@x.test', name: 'Ana', role: 'member', disabled: false },
  { id: 'u_bia', email: 'bia@x.test', name: 'Bia', role: 'member', disabled: false },
  { id: 'u_caio', email: 'caio@x.test', name: 'Caio', role: 'member', disabled: false },
]
const MEMBERS: Record<string, Array<{ userId: string; role: 'admin' | 'member' }>> = {
  alfa: [
    { userId: 'u_ana', role: 'admin' },
    { userId: 'u_bia', role: 'admin' },
    { userId: 'u_caio', role: 'member' },
  ],
}

function build() {
  const events: TConversationEvent[] = []
  const service = new PersonMessagesService({
    repository: new SqlitePersonMessageRepository(':memory:'),
    events: { publish: (event) => void events.push(event), subscribe: () => () => undefined },
    conversation: async (sessionId) =>
      sessionId === 'gw_alfa'
        ? { ownerId: 'u_caio', projectId: 'alfa' }
        : sessionId === 'gw_solta'
          ? { ownerId: 'u_ana' }
          : sessionId === 'gw_filha'
            ? { ownerId: 'u_caio', projectId: 'alfa', delegated: true }
            : undefined,
    members: (projectId) => MEMBERS[projectId] ?? [],
    accounts: () => ACCOUNTS,
  })
  return { service, events }
}

describe('PersonMessagesService', () => {
  it('💬 admins: todos os do projeto da conversa, cada um com a sua cópia; o sino de cada um ao vivo', async () => {
    const { service, events } = build()
    assert.deepStrictEqual(
      await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title: 'Preciso de um OK', body: 'Posso subir?', level: 'attention', turn: 7 }),
      ['Ana', 'Bia'],
    )
    assert.deepStrictEqual(
      events.map((event) => event.type === 'message.created' && [event.recipientId, event.unread]),
      [
        ['u_ana', 1],
        ['u_bia', 1],
      ],
    )
    const [thread] = service.threads('u_ana')
    assert.deepStrictEqual(
      [thread.conversationId, thread.agentId, thread.title, thread.unread, thread.last.turn, thread.last.level],
      ['gw_alfa', 'zeus', 'Preciso de um OK', 1, 7, 'attention'],
    )
    assert.strictEqual(thread.id, thread.requestId, 'o pedido é o próprio item')
    service.markRead('u_ana', thread.id)
    assert.strictEqual(service.unread('u_ana'), 0)
    assert.strictEqual(service.unread('u_bia'), 1, 'ler é de cada um')
  })

  it('⛔ subconversa (delegação) não manda mensagem à pessoa, nem aviso: reporta a quem delegou', async () => {
    const { service, events } = build()
    for (const level of ['info', 'attention'])
      await assert.rejects(service.send({ sessionId: 'gw_filha', agentId: 'zeus', to: 'owner', body: 'Terminei', level }), /delegated conversation/)
    assert.deepStrictEqual([events.length, service.unread('u_caio')], [0, 0])
  })

  it('owner: a dona da conversa; uma pessoa só se for do projeto (pelo nome ou e-mail)', async () => {
    const { service } = build()
    assert.deepStrictEqual(await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', body: 'Terminei' }), ['Caio'])
    assert.deepStrictEqual(await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'BIA@x.test', body: 'oi' }), ['Bia'])
    assert.deepStrictEqual(await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'ana', body: 'oi' }), ['Ana'])
    await assert.rejects(
      service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'root@x.test', body: 'oi' }),
      /is not in this project. Use admins, owner or one of: Ana, Bia, Caio/,
    )
  })

  it('sem projeto: admins são os do gateway; mensagem vazia e conversa que não existe são recusadas', async () => {
    const { service } = build()
    assert.deepStrictEqual(await service.send({ sessionId: 'gw_solta', agentId: 'atlas', to: 'admins', body: 'x' }), ['Root'])
    await assert.rejects(service.send({ sessionId: 'gw_solta', agentId: 'atlas', to: 'admins', body: '  ' }), /message is required/)
    await assert.rejects(service.send({ sessionId: 'gw_sumiu', agentId: 'atlas', to: 'admins', body: 'x' }), /not found/)
  })

  it('arquivar tira da lista; mensagem nova reabre o fio', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', body: 'um' })
    service.setArchived('u_caio', 'gw_alfa', true)
    assert.deepStrictEqual([service.threads('u_caio').length, service.threads('u_caio', true).length], [0, 1])
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', body: 'dois' })
    assert.deepStrictEqual(
      service.threads('u_caio').map((thread) => thread.last.body),
      ['dois'],
    )
    assert.deepStrictEqual(
      service.thread('u_caio', 'gw_alfa').map((message) => message.body),
      ['um', 'dois'],
    )
  })

  it('🎯 notify com replyTo: a resposta do agente fica no item do pedido, na cópia de cada um; pedido novo com replyTo, erro', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title: 'Preciso de um OK', body: 'Posso subir?', level: 'attention' })
    const asked = service.thread('u_ana', 'gw_alfa')[0]
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', body: 'Subi.', replyTo: asked.id })
    for (const who of ['u_ana', 'u_bia']) {
      const [request, answer] = service.thread(who, 'gw_alfa')
      assert.deepStrictEqual([answer.body, answer.replyTo], ['Subi.', request.id])
    }
    await assert.rejects(service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', body: 'x', replyTo: 'm_nada' }), /not a request/)
    await assert.rejects(service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', body: 'x', level: 'urgent', replyTo: asked.id }), /info answer/)
  })

  it('🎯 sem pedido, a resposta é à última mensagem do ITEM que a pessoa via, não ao pedido mais novo da conversa', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', title: 'Apagar a tabela', body: 'Apague a tabela X.' })
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', title: 'Trocar o token', body: 'Gere um token.', level: 'attention' })
    const reply = service.reply('u_caio', 'gw_alfa', 'Conseguiu?', 'Caio')
    assert.match(reply.input, /à sua mensagem "Apagar a tabela"/)
    assert.doesNotMatch(reply.input, /Trocar o token/)
  })

  it('💬 a resposta da pessoa vai para o fio de todos (lida para quem escreveu) e vira o texto da conversa, com quem e sobre o quê', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title: 'Preciso de um OK', body: 'Posso subir?' })
    const reply = service.reply('u_ana', 'gw_alfa', 'Pode, sim', 'Ana')
    const sent = service.thread('u_ana', 'gw_alfa')[0]
    assert.deepStrictEqual(reply, {
      input: `[Resposta de Ana pela caixa de Mensagens à sua mensagem "Preciso de um OK" (${sent.id})]\n\nPode, sim`,
      agentId: 'zeus',
      conversationId: 'gw_alfa',
    })
    assert.deepStrictEqual(
      service.thread('u_bia', 'gw_alfa').map((message) => [message.from, message.body, message.authorId]),
      [
        ['agent', 'Posso subir?', undefined],
        ['person', 'Pode, sim', 'u_ana'],
      ],
    )
    assert.ok(service.thread('u_ana', 'gw_alfa').at(-1)?.readAt, 'lida para quem escreveu')
    assert.throws(() => service.reply('u_caio', 'gw_alfa', 'eu também', 'Caio'), /no such thread/, 'quem não recebeu não responde')
    service.mirror('gw_alfa', 'zeus', 'Subindo agora.')
    assert.deepStrictEqual(service.thread('u_ana', 'gw_alfa').at(-1)?.body, 'Subindo agora.')
    assert.strictEqual(service.unread('u_ana'), 2, 'a primeira e a resposta do agente')
  })
})

describe('Mensagens: o aviso no aparelho', () => {
  it('cada mensagem do agente vai para o push de quem recebe; a resposta da pessoa não', async () => {
    const { service } = build()
    const pushed: Array<{ to: string; title?: string; from: string }> = []
    service.usePush((to, message) => void pushed.push({ to, title: message.title, from: message.from }))
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title: 'Acesso', body: 'Libera?' })
    assert.deepStrictEqual(pushed.map((item) => item.to).sort(), ['u_ana', 'u_bia'])
    service.reply('u_ana', 'gw_alfa', 'Liberado', 'Ana')
    assert.strictEqual(pushed.length, 2)
    service.mirror('gw_alfa', 'zeus', 'Feito.')
    assert.strictEqual(pushed.length, 4)
    assert.ok(pushed.every((item) => item.from === 'agent'))
  })

  it('o push falhar não desfaz a mensagem', async () => {
    const { service } = build()
    service.usePush(() => {
      throw new Error('push fora')
    })
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', body: 'Oi' })
    assert.strictEqual(service.unread('u_ana'), 1)
  })
})

describe('Mensagens: um pedido por vez', () => {
  const request = (service: PersonMessagesService, title: string, level = 'attention') =>
    service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title, body: `Corpo de ${title}`, level })

  it('attention/urgent nascem pending; info não tem estado; a contagem de pendentes vai no fio e no total', async () => {
    const { service } = build()
    await request(service, 'A')
    await request(service, 'B', 'urgent')
    await request(service, 'C', 'info')
    const messages = service.thread('u_ana', 'gw_alfa')
    assert.deepStrictEqual(
      messages.map((message) => message.status),
      ['pending', 'pending', undefined],
    )
    // Cada pedido é um item; o aviso comum fica no item da conversa.
    assert.deepStrictEqual(
      service.threads('u_ana').map((thread) => [thread.id === 'gw_alfa' ? 'conversa' : 'pedido', thread.pending]),
      [
        ['conversa', 0],
        ['pedido', 1],
        ['pedido', 1],
      ],
    )
    assert.strictEqual(service.pending('u_ana'), 2)
  })

  it('responder com replyTo: o pedido vira answered (só para quem respondeu), a resposta leva replyTo e o texto nomeia o pedido', async () => {
    const { service } = build()
    await request(service, 'Subir?')
    await request(service, 'Apagar?')
    const [first] = service.thread('u_ana', 'gw_alfa')
    const reply = service.reply('u_ana', 'gw_alfa', 'Pode', 'Ana', first.id)
    assert.strictEqual(reply.input, `[Resposta de Ana pela caixa de Mensagens a "Subir?" (pedido ${first.id})]\n\nPode`)
    const mine = service.thread('u_ana', 'gw_alfa')
    assert.deepStrictEqual([mine[0].status, mine[1].status, mine[0].answeredAt instanceof Date], ['answered', 'pending', true])
    assert.strictEqual(mine.at(-1)?.replyTo, first.id)
    const items = new Map(service.threads('u_ana').map((thread) => [thread.id, thread]))
    assert.deepStrictEqual([items.get(first.id)?.pending, items.get(mine[1].id)?.pending], [0, 1])
    assert.deepStrictEqual(
      service.thread('u_ana', first.id).map((message) => message.from),
      ['agent', 'person'],
      'o item do pedido traz a resposta a ele',
    )
    const bia = service.thread('u_bia', 'gw_alfa')
    assert.strictEqual(bia[0].status, 'pending', 'o pedido do outro destinatário segue pendente')
    assert.strictEqual(bia.at(-1)?.replyTo, bia[0].id, 'a cópia dele aponta para o pedido dele')
  })

  it('sem título o rótulo usa os primeiros 60 caracteres do corpo; sem replyTo nada muda de estado', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'owner', body: 'x'.repeat(100), level: 'urgent' })
    const [asked] = service.thread('u_caio', 'gw_alfa')
    assert.ok(service.reply('u_caio', 'gw_alfa', 'ok', 'Caio', asked.id).input.includes(`"${'x'.repeat(60)}" (pedido`))
    await request(service, 'Outro')
    service.reply('u_ana', 'gw_alfa', 'solta', 'Ana')
    assert.strictEqual(service.thread('u_ana', 'gw_alfa')[0].status, 'pending')
  })

  it('replyTo inválido (info, pessoa, inexistente, de outro fio) é recusado com o campo replyTo', async () => {
    const { service } = build()
    await request(service, 'Pedido')
    await request(service, 'Aviso', 'info')
    const [, info] = service.thread('u_ana', 'gw_alfa')
    for (const bad of [info.id, 'm_nao_existe']) {
      assert.throws(
        () => service.reply('u_ana', 'gw_alfa', 'x', 'Ana', bad),
        (error: unknown) => error instanceof PersonMessageError && error.field === 'replyTo',
      )
    }
    const otherThread = service.thread('u_bia', 'gw_alfa')[0].id
    assert.throws(
      () => service.reply('u_ana', 'gw_alfa', 'x', 'Ana', otherThread),
      (error: unknown) => error instanceof PersonMessageError && error.field === 'replyTo',
      'id da cópia de outro',
    )
  })

  it('resolver e reabrir: só pedido do próprio fio; info e inexistente são recusados', async () => {
    const { service } = build()
    await request(service, 'Pedido')
    await request(service, 'Aviso', 'info')
    const [asked, info] = service.thread('u_ana', 'gw_alfa')
    service.setStatus('u_ana', 'gw_alfa', asked.id, 'resolved')
    assert.deepStrictEqual([service.thread('u_ana', 'gw_alfa')[0].status, service.pending('u_ana')], ['resolved', 0])
    service.setStatus('u_ana', 'gw_alfa', asked.id, 'pending')
    assert.strictEqual(service.pending('u_ana'), 1)
    assert.throws(
      () => service.setStatus('u_ana', 'gw_alfa', info.id, 'resolved'),
      (error: unknown) => error instanceof PersonMessageError && error.field === 'status',
    )
    assert.throws(() => service.setStatus('u_bia', 'gw_alfa', asked.id, 'resolved'), /no such message/, 'o id é da cópia da Ana')
    assert.throws(() => service.setStatus('u_ana', 'gw_alfa', asked.id, 'answered' as never), /status must be/)
  })
})

describe('Mensagens: um item por pedido', () => {
  const request = (service: PersonMessagesService, title: string) => service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title, body: title, level: 'attention' })

  it('responder pelo item do pedido responde a ele; o retorno do agente volta para o mesmo item', async () => {
    const { service } = build()
    await request(service, 'Subir?')
    await request(service, 'Apagar?')
    const [first] = service.thread('u_ana', 'gw_alfa')
    const reply = service.reply('u_ana', first.id, 'Pode', 'Ana')
    assert.strictEqual(reply.conversationId, 'gw_alfa')
    assert.strictEqual(service.thread('u_ana', first.id)[0].status, 'answered')
    service.mirror('gw_alfa', 'zeus', 'Subi.')
    assert.deepStrictEqual(
      service.thread('u_ana', first.id).map((message) => [message.from, message.body]),
      [
        ['agent', 'Subir?'],
        ['person', 'Pode'],
        ['agent', 'Subi.'],
      ],
    )
    const item = service.threads('u_ana').find((thread) => thread.id === first.id)
    assert.deepStrictEqual([item?.unread, item?.last.body], [2, 'Subi.'], 'o pedido e o retorno, não lidos')
  })

  it('arquivar um pedido não leva os outros; mensagem nova no pedido o reabre', async () => {
    const { service } = build()
    await request(service, 'Subir?')
    await request(service, 'Apagar?')
    const [first, second] = service.thread('u_ana', 'gw_alfa')
    service.setArchived('u_ana', first.id, true)
    assert.deepStrictEqual(
      service.threads('u_ana').map((thread) => thread.id),
      [second.id],
    )
    assert.deepStrictEqual(
      service.threads('u_ana', true).map((thread) => thread.id),
      [first.id],
    )
    service.reply('u_bia', 'gw_alfa', 'Pode', 'Bia', service.thread('u_bia', 'gw_alfa')[0].id)
    assert.ok(
      service.threads('u_ana').some((thread) => thread.id === first.id),
      'a resposta de outra pessoa ao pedido reabre o item',
    )
  })

  it('o id da conversa segue valendo: a conversa inteira (voz e app do Mac) e o status pelo pedido', async () => {
    const { service } = build()
    await request(service, 'Subir?')
    const [first] = service.thread('u_ana', 'gw_alfa')
    assert.deepStrictEqual(service.resolve('u_ana', first.id), { conversationId: 'gw_alfa', requestId: first.id })
    assert.deepStrictEqual(service.resolve('u_ana', 'gw_alfa'), { conversationId: 'gw_alfa' })
    assert.strictEqual(service.resolve('u_ana', 'm_nada'), undefined)
    service.setStatus('u_ana', first.id, first.id, 'resolved')
    assert.strictEqual(service.thread('u_ana', 'gw_alfa')[0].status, 'resolved')
  })
})
