import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IConversationSession } from '@domain/models/Conversation.Model'
import { TConversationEvent } from '@domain/ports/ConversationEvents.Port'
import { InMemoryConversationEvents } from '@infra/events/InMemory.ConversationEvents'
import { NotifyingConversationRepository } from './Notifying.ConversationRepository'
import { SqliteConversationRepository } from './Sqlite.ConversationRepository'

describe('NotifyingConversationRepository', () => {
  const session: IConversationSession = {
    id: 's1',
    agentId: 'pesquisa-teste',
    provider: 'google',
    mode: 'chat',
    model: 'gemini-3.7-flash',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    turns: 1,
    usage: {},
  }

  const build = () => {
    const events = new InMemoryConversationEvents()
    const seen: TConversationEvent[] = []
    events.subscribe((event) => seen.push(event))

    return { repo: new NotifyingConversationRepository(new SqliteConversationRepository(':memory:'), events), seen, events }
  }

  it('o cabeçalho sozinho não avisa; o turno avisa uma vez, já com a prévia gravada', async () => {
    const { repo, seen } = build()

    await repo.saveSession(session)
    assert.deepStrictEqual(seen, [])

    await repo.appendTurn({ sessionId: 's1', index: 0, at: new Date('2026-09-01T10:01:00Z'), request: 'oi', text: 'olá', toolCalls: [] })
    assert.strictEqual(seen.length, 1)
    const [first] = seen as TConversationEvent[]
    assert.strictEqual(first.type === 'conversation.updated' && first.session.preview?.text, 'olá')
  })

  it('apagar o que não existe não avisa nada', async () => {
    const { repo, seen } = build()

    await repo.deleteSession('nunca-existiu')

    assert.deepStrictEqual(seen, [])
  })

  it('um ouvinte que lança não impede a gravação nem os outros ouvintes', async () => {
    const { repo, seen, events } = build()
    events.subscribe(() => {
      throw new Error('aba com defeito')
    })

    await repo.saveSession(session)
    const stored = await repo.appendTurn({ sessionId: 's1', index: 0, at: new Date(), request: 'oi', text: 'olá', toolCalls: [] })

    assert.strictEqual(stored, 0)
    assert.strictEqual(seen.length, 1)
  })
})
