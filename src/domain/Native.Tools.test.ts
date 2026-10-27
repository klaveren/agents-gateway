import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentIssues, IAgentRules } from './Agent.Policy'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'
import { NATIVE_TOOLS, nativeToolsOf } from './Native.Tools'

describe('Native.Tools', () => {
  it('ids únicos, todos com o prefixo sdk:', () => {
    const ids = NATIVE_TOOLS.map((tool) => tool.id)
    assert.strictEqual(new Set(ids).size, ids.length)
    assert.ok(ids.every((id) => id.startsWith('sdk:')))
  })

  it('separa as nativas do agente por protocolo', () => {
    assert.deepStrictEqual(
      nativeToolsOf(['sdk:WebSearch', 'sdk:google:google_search', 'run_bash'], EProvider.CLAUDE).map((tool) => tool.sdkName),
      ['WebSearch'],
    )
  })

  describe('regra do agente', () => {
    const rules: IAgentRules = { takenIds: [], knownTools: ['search_web'], providerOf: () => EProvider.CLAUDE }
    const agent = (over: Partial<IAgent> = {}): IAgent => ({
      id: 'pesquisa',
      name: 'Pesquisa',
      providers: [{ provider: 'claude', models: ['claude-sonnet-5'] }],
      systemPrompt: 'p',
      modes: [EMode.AGENT],
      allowedTools: [],
      ...over,
    })
    const messages = (over: Partial<IAgent>, extra: Partial<IAgentRules> = {}) => agentIssues(agent(over), { ...rules, ...extra }).map((issue) => issue.message)

    it('nativa do SDK certo passa — inclusive as que alcançam o servidor, sem perímetro de deploy', () => {
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:WebSearch', 'search_web'] }), [])
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:Bash', 'sdk:Read', 'sdk:Write', 'sdk:WebFetch'] }), [])
    })

    it('⛔ recusa: nativa de outro SDK ou desconhecida', () => {
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:google:google_search'] }), ['Google Search is a google SDK tool'])
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:Inexistente'] }), ['unknown SDK tool: sdk:Inexistente'])
    })

    it('⛔ hospedada da OpenAI só no provider oficial', () => {
      const openai = { provider: 'agregador', models: ['x'], allowedTools: ['sdk:openai:web_search'] }

      assert.deepStrictEqual(messages(openai, { protocolOf: () => EProvider.OPENAI }), ['Busca na web works only with the official provider'])
    })
  })
})
