import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CancelSessionUseCase } from './CancelSession.Usecase'
import { IAgentProvider } from '@domain/ports/AgentProvider'

describe('CancelSessionUseCase', () => {
  it('should delegate cancel to AgentProvider', async () => {
    let callCount = 0
    const mockProvider: IAgentProvider = {
      createSession: async () => ({}) as unknown as import('@domain/models/AgentSession').IAgentSession,
      sendMessage: async function* () {},
      cancel: async (agentId: string, sessionId: string) => {
        callCount++
        assert.strictEqual(agentId, 'agent-1')
        assert.strictEqual(sessionId, 'sess-1')
      },
    }

    const usecase = new CancelSessionUseCase(mockProvider)
    await usecase.execute('agent-1', 'sess-1')
    assert.strictEqual(callCount, 1)
  })
})
