import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'
import { CancelSessionUseCase } from './CancelSession.Usecase'

const stubProvider = (overrides: Partial<IAgentProvider> = {}): IAgentProvider => ({
  createSession: async () => ({ id: 's', provider: EProvider.OPENAI, mode: EMode.CHAT, createdAt: new Date() }),
  sendMessage: async function* () {},
  cancel: async () => {},
  dispose: async () => {},
  describe: () => ({}) as ISession,
  list: () => [],
  ...overrides,
})

describe('CancelSessionUseCase', () => {
  it('cancels by session id alone', async () => {
    const seen: string[] = []
    const usecase = new CancelSessionUseCase(stubProvider({ cancel: async (id) => void seen.push(id) }))

    await usecase.execute('sess-1')

    assert.deepStrictEqual(seen, ['sess-1'])
  })
})
