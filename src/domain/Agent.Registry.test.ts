import { describe, it } from 'node:test'
import assert from 'node:assert'
import { AGENT_REGISTRY, filterEnabledAgents, modelFor } from './Agent.Registry'
import { EProvider } from './enums/EProvider.Enum'

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

  describe('AGENTS_ENABLED', () => {
    it('vazio ou ausente mantém todos', () => {
      assert.deepStrictEqual(filterEnabledAgents(AGENT_REGISTRY, undefined), AGENT_REGISTRY)
      assert.deepStrictEqual(filterEnabledAgents(AGENT_REGISTRY, ''), AGENT_REGISTRY)
      assert.deepStrictEqual(filterEnabledAgents(AGENT_REGISTRY, ' , '), AGENT_REGISTRY)
    })

    it('o agente fora da lista não existe', () => {
      const kept = filterEnabledAgents(AGENT_REGISTRY, ' researcher-agent , ghost ')

      assert.deepStrictEqual(
        kept.map((agent) => agent.id),
        ['researcher-agent'],
      )
    })

    it('lista que não casa com nada derruba o boot, dizendo o que não casou', () => {
      assert.throws(() => filterEnabledAgents(AGENT_REGISTRY, 'ghost, nope'), /AGENTS_ENABLED.*ghost, nope/)
    })
  })

  describe('modelFor', () => {
    const [agent] = AGENT_REGISTRY

    it('mantém o modelo que o agente declara', () => {
      assert.strictEqual(modelFor(agent, agent.models[1]), agent.models[1])
    })

    it('cai no primeiro do agente quando o modelo é de outro provider', () => {
      assert.strictEqual(modelFor(agent, 'um-modelo-de-outro-provider'), agent.models[0])
    })

    it('sem modelo pedido não escolhe nenhum: o adapter usa o padrão dele', () => {
      assert.strictEqual(modelFor(agent, undefined), undefined)
      assert.strictEqual(modelFor(agent, ''), undefined)
    })
  })
})
