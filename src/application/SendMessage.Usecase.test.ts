import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'
import { SendMessageUseCase } from './SendMessage.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISession,
  list: () => [],
  ...overrides,
})

describe('SendMessageUseCase', () => {
  it('passes the stream through in order, keyed only by session id', async () => {
    let seenSessionId: string | undefined

    const usecase = new SendMessageUseCase(
      stubProvider({
        sendMessage: async function* (sessionId) {
          seenSessionId = sessionId
          yield { type: 'message.started', sessionId, timestamp: new Date() }
          yield { type: 'text.delta', sessionId, payload: { text: 'Hello' }, timestamp: new Date() }
          yield { type: 'message.completed', sessionId, timestamp: new Date() }
        },
      }),
    )

    const events = []
    for await (const event of usecase.execute('sess-1', { text: 'Hi' })) events.push(event)

    assert.strictEqual(seenSessionId, 'sess-1')
    assert.strictEqual(events.length, 3)
    assert.strictEqual(events[0].type, 'message.started')
    assert.strictEqual(events[1].type, 'text.delta')
    assert.strictEqual(events[1].payload.text, 'Hello')
    assert.strictEqual(events[2].type, 'message.completed')
  })
})
