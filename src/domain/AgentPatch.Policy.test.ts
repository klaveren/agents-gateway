import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { IAgent } from './models/Agent.Model'
import { agentHash, applyAgentPatch, splitAgentPatch } from './AgentPatch.Policy'

const theo: IAgent = {
  id: 'theo',
  name: 'Theo',
  providers: [{ provider: 'claude', models: ['m'] }],
  systemPrompt: 'p',
  modes: [EMode.CHAT],
  allowedTools: ['read_doc'],
  adminOnly: true,
}

describe('AgentPatch.Policy — o patch do agente, campo a campo', () => {
  it('aplica só os campos pedidos; `null` e o vazio do campo tiram', () => {
    const next = applyAgentPatch(theo, { name: 'T', adminOnly: null, soul: '  ', env: {} })
    assert.deepStrictEqual([next.name, next.adminOnly, 'soul' in next, next.systemPrompt], ['T', undefined, false, 'p'])
  })

  it('o campo que amplia fica pendente (inteiro); o resto vale já', () => {
    const split = splitAgentPatch(theo, { name: 'T', allowedTools: ['agent:ana'], adminOnly: false })
    assert.deepStrictEqual(split.immediate, { name: 'T' })
    assert.deepStrictEqual(Object.keys(split.pending).sort(), ['adminOnly', 'allowedTools'])
    assert.deepStrictEqual(
      split.widenings.map((item) => item.key),
      ['agent/theo#adminOnly-', 'agent/theo#allowedTools+agent:ana'],
    )
    assert.strictEqual(split.agent.name, 'T')
  })

  it('a lane nova roda as ferramentas que já havia: amplia, fica pendente', () => {
    const split = splitAgentPatch(theo, { modes: [EMode.CHAT, EMode.AGENT] })
    assert.deepStrictEqual(split.immediate, {})
    assert.deepStrictEqual(
      split.widenings.map((item) => item.key),
      ['agent/theo#modes+agent'],
    )
  })

  it('sem ampliação, vale tudo; a impressão muda com o agente', () => {
    const split = splitAgentPatch(theo, { allowedTools: [], systemPrompt: 'q' })
    assert.deepStrictEqual(split.pending, {})
    assert.notStrictEqual(agentHash(split.agent), agentHash(theo))
  })
})
