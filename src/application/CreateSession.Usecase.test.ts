import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AgentNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISessionRecord } from '@infra/session/Session.Store'
import { CreateSessionUseCase } from './CreateSession.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISessionRecord,
  list: () => [],
  ...overrides,
})

describe('CreateSessionUseCase', () => {
  it('delegates to the provider and returns the session', async () => {
    const usecase = new CreateSessionUseCase(
      stubProvider({
        createSession: async () => ({
          id: 'mock-session-123',
          provider: EProvider.OPENAI,
          mode: EMode.CHAT,
          createdAt: new Date(),
        }),
      }),
    )

    const result = await usecase.execute({ agentId: 'analyst-agent' })

    assert.strictEqual(result.id, 'mock-session-123')
    assert.strictEqual(result.provider, EProvider.OPENAI)
  })

  it('lets a named domain failure through untouched', async () => {
    const usecase = new CreateSessionUseCase(
      stubProvider({
        createSession: async () => {
          throw new AgentNotFoundError('nope')
        },
      }),
    )

    await assert.rejects(usecase.execute({ agentId: 'nope' }), AgentNotFoundError)
  })
})
