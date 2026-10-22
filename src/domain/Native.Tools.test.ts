import assert from 'node:assert'
import { describe, it } from 'node:test'
import { agentIssues, IAgentRules } from './Agent.Policy'
import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'
import { NATIVE_TOOLS, nativeTool, nativeToolAllowed, nativeToolsOf } from './Native.Tools'

describe('Native.Tools', () => {
  it('ids únicos, todos com o prefixo sdk:', () => {
    const ids = NATIVE_TOOLS.map((tool) => tool.id)
    assert.strictEqual(new Set(ids).size, ids.length)
    assert.ok(ids.every((id) => id.startsWith('sdk:')))
  })

  it('⛔ perímetro padrão: hospedadas e de sessão sim; as que tocam o servidor, não', () => {
    const allowed = (id: string) => nativeToolAllowed(nativeTool(id)!, {})

    assert.strictEqual(allowed('sdk:WebSearch'), true)
    assert.strictEqual(allowed('sdk:TodoWrite'), true)
    assert.strictEqual(allowed('sdk:google:google_search'), true)
    for (const id of ['sdk:Bash', 'sdk:Read', 'sdk:Write', 'sdk:WebFetch']) assert.strictEqual(allowed(id), false, id)
  })

  it('NATIVE_TOOLS_ENABLED libera o que lista (pelo id ou pelo nome do SDK) — e fecha o resto', () => {
    const env = { NATIVE_TOOLS_ENABLED: 'Read, sdk:Grep' }

    assert.strictEqual(nativeToolAllowed(nativeTool('sdk:Read')!, env), true)
    assert.strictEqual(nativeToolAllowed(nativeTool('sdk:Grep')!, env), true)
    assert.strictEqual(nativeToolAllowed(nativeTool('sdk:WebSearch')!, env), false)
  })

  it('separa as nativas do agente por protocolo', () => {
    assert.deepStrictEqual(
      nativeToolsOf(['sdk:WebSearch', 'sdk:google:google_search', 'run_bash'], EProvider.CLAUDE).map((tool) => tool.sdkName),
      ['WebSearch'],
    )
  })

  describe('regra do agente', () => {
    const rules: IAgentRules = { takenIds: [], knownTools: ['search_web'], providerOf: () => EProvider.CLAUDE, nativeAllowed: (tool) => nativeToolAllowed(tool, {}) }
    const agent = (over: Partial<IAgent> = {}): IAgent => ({
      id: 'pesquisa',
      name: 'Pesquisa',
      provider: 'claude',
      systemPrompt: 'p',
      models: ['claude-sonnet-5'],
      modes: [EMode.AGENT],
      allowedTools: [],
      ...over,
    })
    const messages = (over: Partial<IAgent>, extra: Partial<IAgentRules> = {}) => agentIssues(agent(over), { ...rules, ...extra }).map((issue) => issue.message)

    it('nativa do SDK certo e no perímetro passa', () => {
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:WebSearch', 'search_web'] }), [])
    })

    it('⛔ recusa: nativa de outro SDK, fora do perímetro, ou desconhecida', () => {
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:google:google_search'] }), ['Google Search is a google SDK tool'])
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:Bash'] }), ['blocked by NATIVE_TOOLS_ENABLED: sdk:Bash'])
      assert.deepStrictEqual(messages({ allowedTools: ['sdk:Inexistente'] }), ['unknown SDK tool: sdk:Inexistente'])
    })

    it('⛔ hospedada da OpenAI só no provider oficial', () => {
      const openai = { provider: 'agregador', models: ['x'], allowedTools: ['sdk:openai:web_search'] }

      assert.deepStrictEqual(messages(openai, { protocolOf: () => EProvider.OPENAI }), ['Busca na web works only with the official provider'])
    })
  })
})
