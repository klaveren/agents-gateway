import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISessionRecord } from '@infra/session/Session.Store'
import { ListSessionsUseCase } from './ListSessions.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISessionRecord,
  list: () => [],
  ...overrides,
})

describe('ListSessionsUseCase', () => {
  it('returns what the provider lists', async () => {
    const records = [{ id: 'a' }, { id: 'b' }] as ISessionRecord[]
    const usecase = new ListSessionsUseCase(stubProvider({ list: () => records }))

    assert.deepStrictEqual(
      (await usecase.execute()).map((r) => r.id),
      ['a', 'b'],
    )
  })
})
