import { describe, it } from 'node:test'
import assert from 'node:assert'
import { agentIssues } from './Agent.Policy'
import { AGENT_SEED } from './Agent.Seed'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'

describe('AGENT_SEED', () => {
  it('o Atlas dos usuários e o Atlas Admin', () => {
    assert.deepStrictEqual(
      AGENT_SEED.map((agent) => agent.id),
      ['atlas', 'atlas-admin'],
    )
  })

  it('⚖️ o sistema operacional só no Atlas Admin, que só o admin abre; o Atlas fica no MCP do gateway', () => {
    const [atlas, admin] = AGENT_SEED

    assert.ok(!atlas.adminOnly)
    assert.ok(atlas.allowedTools.every((tool) => tool.startsWith('mcp:gateway/') || tool === 'sdk:WebSearch'))
    assert.strictEqual(admin.adminOnly, true)
    for (const tool of ['sdk:Bash', 'sdk:Read', 'sdk:Write', 'sdk:Edit']) assert.ok(admin.allowedTools.includes(tool), tool)
    assert.ok(atlas.allowedTools.every((tool) => admin.allowedTools.includes(tool)))
  })

  it('o Atlas Admin instala o que falta pela guia Pacotes; o Atlas dos usuários não', () => {
    const [atlas, admin] = AGENT_SEED
    const packages = ['list_packages', 'search_packages', 'install_package', 'remove_package'].map((tool) => `mcp:gateway/${tool}`)
    for (const tool of packages) assert.ok(admin.allowedTools.includes(tool), tool)
    assert.ok(packages.every((tool) => !atlas.allowedTools.includes(tool)))
    assert.match(admin.systemPrompt, /search_packages/)
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

  it('os dois passam pela regra de agente (as tools do próprio gateway vêm do servidor MCP `gateway`)', () => {
    for (const agent of AGENT_SEED) {
      const issues = agentIssues(agent, {
        takenIds: [],
        knownTools: [],
        providerOf: (model) => (model.startsWith('claude') ? EProvider.CLAUDE : undefined),
        mcpServerExists: (server) => server === 'gateway',
      })

      assert.deepStrictEqual(issues, [], agent.id)
    }
  })
})
