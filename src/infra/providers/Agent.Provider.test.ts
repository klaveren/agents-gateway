import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { adapterKey, AgentProvider } from './Agent.Provider'

interface ISpy {
  adapter: IAgentAdapter
  calls: string[]
  lastInput?: ICreateSessionInput
}

function spyAdapter(mode: EMode): ISpy {
  const calls: string[] = []
  const spy: ISpy = {
    calls,
    adapter: {
      async createSession(_agent, input) {
        calls.push('createSession')
        spy.lastInput = input
        return { id: 'session-1', provider: EProvider.GOOGLE, mode, createdAt: new Date() } satisfies IAgentSession
      },
      // eslint-disable-next-line require-yield
      async *sendMessage() {
        calls.push('sendMessage')
      },
      async cancel() {
        calls.push('cancel')
      },
    },
  }
  return spy
}

describe('AgentProvider', () => {
  const chatId = `${EProvider.GOOGLE}-${EMode.CHAT}-0000`
  const agentId = `${EProvider.GOOGLE}-${EMode.AGENT}-0000`

  const providerWith = (chat: IAgentAdapter, agent: IAgentAdapter) =>
    new AgentProvider(
      new Map([
        [adapterKey(EProvider.GOOGLE, EMode.CHAT), chat],
        [adapterKey(EProvider.GOOGLE, EMode.AGENT), agent],
      ]),
    )

  it('defaults to the chat lane when no mode is given', async () => {
    const chat = spyAdapter(EMode.CHAT)
    const agent = spyAdapter(EMode.AGENT)

    await providerWith(chat.adapter, agent.adapter).createSession({ agentId: 'researcher-agent' })

    assert.deepStrictEqual(chat.calls, ['createSession'])
    assert.deepStrictEqual(agent.calls, [])
    assert.strictEqual(chat.lastInput?.mode, EMode.CHAT)
  })

  it('routes createSession to the requested lane', async () => {
    const chat = spyAdapter(EMode.CHAT)
    const agent = spyAdapter(EMode.AGENT)

    await providerWith(chat.adapter, agent.adapter).createSession({
      agentId: 'researcher-agent',
      mode: EMode.AGENT,
    })

    assert.deepStrictEqual(agent.calls, ['createSession'])
    assert.deepStrictEqual(chat.calls, [])
  })

  it('reads the lane back off the session id for sendMessage and cancel', async () => {
    const chat = spyAdapter(EMode.CHAT)
    const agent = spyAdapter(EMode.AGENT)
    const provider = providerWith(chat.adapter, agent.adapter)

    for await (const event of provider.sendMessage('researcher-agent', agentId, { text: 'hi' })) {
      void event
    }
    await provider.cancel('researcher-agent', chatId)

    assert.deepStrictEqual(agent.calls, ['sendMessage'])
    assert.deepStrictEqual(chat.calls, ['cancel'])
  })

  it('rejects a lane the agent does not declare', async () => {
    const chat = spyAdapter(EMode.CHAT)
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]))

    await assert.rejects(provider.createSession({ agentId: 'researcher-agent', mode: 'telepathy' as EMode }), /does not support mode/)
  })

  it('throws when the agent does not exist', async () => {
    const chat = spyAdapter(EMode.CHAT)
    const provider = new AgentProvider(new Map([[adapterKey(EProvider.GOOGLE, EMode.CHAT), chat.adapter]]))

    await assert.rejects(provider.createSession({ agentId: 'nope' }), /Agent not found/)
    await assert.rejects(provider.cancel('nope', chatId), /Agent not found/)

    const stream = provider.sendMessage('nope', chatId, { text: 'hi' })
    await assert.rejects(stream[Symbol.asyncIterator]().next(), /Agent not found/)
  })

  it('throws when no adapter is registered for the lane', async () => {
    const provider = new AgentProvider(new Map())

    await assert.rejects(provider.createSession({ agentId: 'researcher-agent' }), /Adapter not found/)
  })
})
