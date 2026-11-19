import assert from 'node:assert'
import { describe, it } from 'node:test'
import { TConversationEvent } from '@domain/ports/ConversationEvents.Port'
import { SqlitePersonMessageRepository } from '@infra/persistence/Sqlite.PersonMessageRepository'
import { PersonMessagesService } from './PersonMessages.Service'

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
    conversation: async (sessionId) => (sessionId === 'gw_alfa' ? { ownerId: 'u_caio', projectId: 'alfa' } : sessionId === 'gw_solta' ? { ownerId: 'u_ana' } : undefined),
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
    service.markRead('u_ana', 'gw_alfa')
    assert.strictEqual(service.unread('u_ana'), 0)
    assert.strictEqual(service.unread('u_bia'), 1, 'ler é de cada um')
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

  it('💬 a resposta da pessoa vai para o fio de todos (lida para quem escreveu) e vira o texto da conversa, com quem e sobre o quê', async () => {
    const { service } = build()
    await service.send({ sessionId: 'gw_alfa', agentId: 'zeus', to: 'admins', title: 'Preciso de um OK', body: 'Posso subir?' })
    const reply = service.reply('u_ana', 'gw_alfa', 'Pode, sim', 'Ana')
    assert.deepStrictEqual(reply, { input: '[Resposta de Ana pela caixa de Mensagens (sobre "Preciso de um OK")]\n\nPode, sim', agentId: 'zeus' })
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
