import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SessionNotFoundError } from '@domain/errors/Domain.Error'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISessionRecord } from '@infra/session/Session.Store'
import { DeleteSessionUseCase } from './DeleteSession.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISessionRecord,
  list: () => [],
  ...overrides,
})

describe('DeleteSessionUseCase', () => {
  it('disposes by session id', async () => {
    const seen: string[] = []
    const usecase = new DeleteSessionUseCase(stubProvider({ dispose: async (id) => void seen.push(id) }))

    await usecase.execute('sess-1')

    assert.deepStrictEqual(seen, ['sess-1'])
  })

  it('surfaces a missing session as a named failure', async () => {
    const usecase = new DeleteSessionUseCase(
      stubProvider({
        dispose: async (id) => {
          throw new SessionNotFoundError(id)
        },
      }),
    )

    await assert.rejects(usecase.execute('gone'), SessionNotFoundError)
  })
})
