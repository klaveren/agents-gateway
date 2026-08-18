import { describe, it } from 'node:test'
import assert from 'node:assert'
import { SendMessageUseCase } from './SendMessage.Usecase'
import { IAgentProvider } from '@domain/ports/AgentProvider'

describe('SendMessageUseCase', () => {
  it('should yield events from the provider stream', async () => {
    const mockProvider: IAgentProvider = {
      createSession: async () => ({}) as unknown as import('@domain/models/AgentSession').IAgentSession,
      sendMessage: async function* (agentId: string, sessionId: string, _input: import('@domain/models/MessageInput').IMessageInput) {
        yield { type: 'message.started', sessionId, timestamp: new Date() }
        yield { type: 'text.delta', sessionId, payload: { text: 'Hello' }, timestamp: new Date() }
        yield { type: 'message.completed', sessionId, timestamp: new Date() }
      },
      cancel: async () => {},
    }

    const usecase = new SendMessageUseCase(mockProvider)
    const iterator = usecase.execute('researcher-agent', 'sess-1', { text: 'Hi' })

    const events = []
    for await (const event of iterator) {
      events.push(event)
    }

    assert.strictEqual(events.length, 3)
    assert.strictEqual(events[0].type, 'message.started')
    assert.strictEqual(events[1].type, 'text.delta')
    assert.strictEqual(events[1].payload.text, 'Hello')
    assert.strictEqual(events[2].type, 'message.completed')
  })
})
