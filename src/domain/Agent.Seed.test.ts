import { describe, it } from 'node:test'
import assert from 'node:assert'
import { agentIssues } from './Agent.Policy'
import { AGENT_SEED } from './Agent.Seed'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

describe('AGENT_SEED', () => {
  it('é só o Atlas', () => {
    assert.deepStrictEqual(
      AGENT_SEED.map((agent) => agent.id),
      ['atlas'],
    )
  })

  it('o Atlas é um agente Claude da lane agent, com raciocínio e a WebSearch nativa', () => {
    const [atlas] = AGENT_SEED

    assert.strictEqual(atlas.providers[0].provider, EProvider.CLAUDE)
    assert.deepStrictEqual(atlas.modes, [EMode.AGENT])
    assert.ok(atlas.providers[0].models.includes('claude-sonnet-5'))
    assert.ok(atlas.reasoningEfforts?.includes('high'))
    assert.ok(atlas.allowedTools.includes('sdk:WebSearch'))
  })

  it('⛔ o Atlas não conversa com outros agentes: sem delegação nem send_message / start_conversation', () => {
    const [atlas] = AGENT_SEED

    assert.ok(atlas.allowedTools.every((tool) => !tool.startsWith('agent:')))
    assert.ok(atlas.allowedTools.every((tool) => !/send_message|start_conversation/.test(tool)))
  })

  it('o Atlas passa pela regra de agente (as tools do próprio gateway vêm do servidor MCP `gateway`)', () => {
    const [atlas] = AGENT_SEED
    const issues = agentIssues(atlas, {
      takenIds: [],
      knownTools: [],
      providerOf: (model) => (model.startsWith('claude') ? EProvider.CLAUDE : undefined),
      mcpServerExists: (server) => server === 'gateway',
      nativeAllowed: () => true,
    })

    assert.deepStrictEqual(issues, [])
  })
})
