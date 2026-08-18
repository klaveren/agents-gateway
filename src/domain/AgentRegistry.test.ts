import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AGENT_REGISTRY } from './AgentRegistry'
import { EProvider } from './enums/EProvider'

describe('AgentRegistry', () => {
  it('should export an array of agents', () => {
    assert.ok(Array.isArray(AGENT_REGISTRY), 'AGENT_REGISTRY should be an array')
    assert.ok(AGENT_REGISTRY.length > 0, 'AGENT_REGISTRY should not be empty')
  })

  it('should contain a Researcher Agent (Google)', () => {
    const agent = AGENT_REGISTRY.find((a) => a.id === 'researcher-agent')
    assert.ok(agent, 'Researcher agent should exist')
    assert.strictEqual(agent.provider, EProvider.GOOGLE)
    assert.ok(agent.models.includes('gemini-3.7-flash'))
    assert.ok(agent.reasoningEfforts?.includes('medium'))
  })

  it('should contain a SysOps Agent (Claude)', () => {
    const agent = AGENT_REGISTRY.find((a) => a.id === 'sysops-agent')
    assert.ok(agent, 'SysOps agent should exist')
    assert.strictEqual(agent.provider, EProvider.CLAUDE)
    assert.ok(agent.models.includes('claude-sonnet-5'))
    assert.ok(agent.reasoningEfforts?.includes('high'))
  })

  it('should contain a Data Analyst Agent (OpenAI)', () => {
    const agent = AGENT_REGISTRY.find((a) => a.id === 'analyst-agent')
    assert.ok(agent, 'Data Analyst agent should exist')
    assert.strictEqual(agent.provider, EProvider.OPENAI)
    assert.ok(agent.models.includes('gpt-5.6-sol'))
    assert.ok(agent.reasoningEfforts?.includes('low'))
  })
})
