import { describe, it } from 'node:test'
import assert from 'node:assert'
import { makeOrchestrator } from './Orchestrator.Factory'
import { AgentProvider } from '@infra/providers/Agent.Provider'

describe('makeOrchestrator Factory', () => {
  it('should create and return an instance of AgentProvider', () => {
    const provider = makeOrchestrator()
    assert.ok(provider instanceof AgentProvider)
  })
})
