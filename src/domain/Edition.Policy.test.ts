import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AGENT_SEED, atlasLitePrompt } from './Agent.Seed'
import { gatewayEdition, LITE_HIDDEN_MCP_TOOLS, withoutLiteTools } from './Edition.Policy'

describe('Edition.Policy', () => {
  it('a edição vem de GATEWAY_EDITION: só `lite` é lite; o resto, PRO', () => {
    assert.strictEqual(gatewayEdition({ GATEWAY_EDITION: ' Lite ' }), 'lite')
    assert.strictEqual(gatewayEdition({ GATEWAY_EDITION: 'outra' }), 'pro')
    assert.strictEqual(gatewayEdition({}), 'pro')
  })

  it('withoutLiteTools tira só as do MCP do gateway que a lite não tem; outro MCP, capacidade e delegação ficam', () => {
    const tools = ['mcp:gateway/save_hook', 'mcp:gateway/list_agents', 'mcp:outro/save_hook', 'cap:web.search', 'agent:builder-skill']
    assert.deepStrictEqual(withoutLiteTools(tools), ['mcp:gateway/list_agents', 'mcp:outro/save_hook', 'cap:web.search', 'agent:builder-skill'])
  })

  it('a semente na lite fica sem nenhuma ferramenta escondida', () => {
    for (const agent of AGENT_SEED) {
      const left = withoutLiteTools(agent.allowedTools)
      assert.ok(
        left.every((tool) => !(tool.startsWith('mcp:gateway/') && LITE_HIDDEN_MCP_TOOLS.has(tool.slice(12)))),
        agent.id,
      )
      assert.ok(left.length < agent.allowedTools.length, agent.id)
    }
  })

  it('o prompt lite da semente não cita ferramenta que a lite não tem; prompt editado não é trocado', () => {
    for (const agent of AGENT_SEED) {
      const lite = atlasLitePrompt(agent)
      assert.ok(lite, agent.id)
      for (const tool of LITE_HIDDEN_MCP_TOOLS) assert.ok(!new RegExp(`\\b${tool}\\b`).test(lite), `${agent.id}: ${tool}`)
      assert.match(lite, /builder-agent/)
      assert.strictEqual(atlasLitePrompt({ ...agent, systemPrompt: `${agent.systemPrompt}\nmeu ajuste` }), undefined)
    }
    assert.match(atlasLitePrompt(AGENT_SEED[1]) ?? '', /## Sistema operacional/)
    assert.strictEqual(atlasLitePrompt({ id: 'outro', systemPrompt: AGENT_SEED[0].systemPrompt }), undefined)
  })
})
