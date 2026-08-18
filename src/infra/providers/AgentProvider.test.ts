import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AgentProvider } from './AgentProvider'
import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { EProvider } from '@domain/enums/EProvider'
import { IAgent } from '@domain/models/Agent'

describe('AgentProvider', () => {
  it('should route createSession to the correct adapter', async () => {
    let callCount = 0
    const mockGoogleAdapter: IAgentAdapter = {
      createSession: async () => {
        callCount++
        return {} as any
      },
      sendMessage: async function* () {},
      cancel: async () => {},
    }

    const map = new Map<EProvider, IAgentAdapter>()
    map.set(EProvider.GOOGLE, mockGoogleAdapter)

    const provider = new AgentProvider(map)

    await provider.createSession({ agentId: 'researcher-agent' })
    assert.strictEqual(callCount, 1)
  })

  it('should route sendMessage to the correct adapter', async () => {
    let callCount = 0
    const mockGoogleAdapter: IAgentAdapter = {
      createSession: async () => ({}) as any,
      sendMessage: async function* () {
        callCount++
        yield { type: 'test' } as any
      },
      cancel: async () => {},
    }

    const map = new Map<EProvider, IAgentAdapter>()
    map.set(EProvider.GOOGLE, mockGoogleAdapter)

    const provider = new AgentProvider(map)

    const iterator = provider.sendMessage('researcher-agent', 'sess-1', { text: 'hi' })
    const events = []
    for await (const event of iterator) {
      events.push(event)
    }
    assert.strictEqual(callCount, 1)
    assert.strictEqual(events.length, 1)
  })

  it('should route cancel to the correct adapter', async () => {
    let callCount = 0
    const mockGoogleAdapter: IAgentAdapter = {
      createSession: async () => ({}) as any,
      sendMessage: async function* () {},
      cancel: async () => {
        callCount++
      },
    }

    const map = new Map<EProvider, IAgentAdapter>()
    map.set(EProvider.GOOGLE, mockGoogleAdapter)

    const provider = new AgentProvider(map)

    await provider.cancel('researcher-agent', 'sess-1')
    assert.strictEqual(callCount, 1)
  })

  it('should throw error if agent is not found during sendMessage', async () => {
    const provider = new AgentProvider(new Map())
    await assert.rejects(async () => {
      const iterator = provider.sendMessage('non-existent', 'sess-1', { text: 'hi' })
      await iterator[Symbol.asyncIterator]().next()
    }, /Agent not found/)
  })

  it('should throw error if agent is not found during cancel', async () => {
    const provider = new AgentProvider(new Map())
    await assert.rejects(async () => {
      await provider.cancel('non-existent', 'sess-1')
    }, /Agent not found/)
  })

  it('should throw error if adapter is not found', async () => {
    const provider = new AgentProvider(new Map()) // Map is empty, missing adapter for GOOGLE
    await assert.rejects(async () => {
      await provider.createSession({ agentId: 'researcher-agent' })
    }, /Adapter not found for provider/)
  })
})
