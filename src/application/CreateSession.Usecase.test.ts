import { describe, it } from 'node:test'
import assert from 'node:assert'
import { CreateSessionUseCase } from './CreateSession.Usecase'
import { IAgentProvider } from '@domain/ports/AgentProvider'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { EProvider } from '@domain/enums/EProvider'

describe('CreateSessionUseCase', () => {
  it('should successfully create a session for an existing agent', async () => {
    // Mock the AgentProvider
    const mockProvider: IAgentProvider = {
      createSession: async (_input: ICreateSessionInput) => ({
        id: 'mock-session-123',
        provider: EProvider.OPENAI,
        createdAt: new Date(),
      }),
      sendMessage: async function* () {
        yield {} as unknown as import('@domain/models/AgentEvent').IAgentEvent
      },
      cancel: async () => {},
    }

    const usecase = new CreateSessionUseCase(mockProvider)
    const input: ICreateSessionInput = { agentId: 'analyst-agent' }

    const result = await usecase.execute(input)
    assert.strictEqual(result.id, 'mock-session-123')
    assert.strictEqual(result.provider, EProvider.OPENAI)
  })

  it('should throw an error if the agent does not exist', async () => {
    const mockProvider: IAgentProvider = {
      createSession: async () => {
        throw new Error('Agent not found')
      },
      sendMessage: async function* () {},
      cancel: async () => {},
    }

    const usecase = new CreateSessionUseCase(mockProvider)
    const input: ICreateSessionInput = { agentId: 'non-existent-agent' }

    await assert.rejects(
      async () => {
        await usecase.execute(input)
      },
      { message: 'Agent not found' },
    )
  })
})
