import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'
import { GetSessionUseCase } from './GetSession.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISession,
  list: () => [],
  ...overrides,
})

describe('GetSessionUseCase', () => {
  it('returns the record the provider describes', async () => {
    const record = { id: 'sess-1', turns: 3 } as ISession
    const usecase = new GetSessionUseCase(stubProvider({ describe: () => record }))

    assert.strictEqual((await usecase.execute('sess-1')).turns, 3)
  })
})
