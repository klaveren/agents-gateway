import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AUTO_TOOLS } from '../Auto.Tools'
import { EMode } from '../enums/EMode.Enum'
import { EProvider } from '../enums/EProvider.Enum'
import { decide } from '../Permission.Policy'
import { IAgent } from './Agent.Model'
import { isEmptyLayer, mergeLocalLayer, trimLocalLayer } from './AgentLocalLayer.Model'

const AUTO = AUTO_TOOLS[0]

/** O agente como veio da origem. */
const origin: IAgent = {
  id: 'sre',
  name: 'SRE',
  projectId: 'logiccus',
  providers: [{ provider: EProvider.CLAUDE, models: ['claude-opus-5'] }],
  systemPrompt: 'faça',
  modes: [EMode.AGENT],
  allowedTools: ['mcp:tickets/*', 'agent:atlas', `off:${AUTO}`],
  permissions: [
    { category: 'terminal', pattern: 'git push *', decision: 'deny' },
    { category: 'terminal', pattern: 'git status', decision: 'allow' },
  ],
}

describe('camada local do agente conectado', () => {
  it('os modelos daqui SUBSTITUEM os da origem; sem escolha local, valem os de lá', () => {
    const local = [{ provider: EProvider.OPENAI, models: ['gpt-5'] }]
    assert.deepEqual(mergeLocalLayer(origin, { providers: local, allowedTools: [], permissions: [] }).providers, local)
    assert.deepEqual(mergeLocalLayer(origin, { allowedTools: [], permissions: [] }).providers, origin.providers)
    assert.deepEqual(mergeLocalLayer(origin, { providers: [], allowedTools: [], permissions: [] }).providers, origin.providers)
  })

  it('ferramentas, MCPs e delegação SOMAM, sem repetir e sem tirar nada da origem', () => {
    const merged = mergeLocalLayer(origin, { allowedTools: ['mcp:local/*', 'agent:atlas', 'agent:ajudante', 'mcp:local/*'], permissions: [] })
    assert.deepEqual(merged.allowedTools, ['mcp:tickets/*', 'agent:atlas', `off:${AUTO}`, 'mcp:local/*', 'agent:ajudante'])
  })

  it('a ferramenta automática que a origem desligou volta quando a camada a pede; a camada não desliga nenhuma', () => {
    const back = mergeLocalLayer(origin, { allowedTools: [AUTO], permissions: [] })
    assert.ok(!back.allowedTools.includes(`off:${AUTO}`) && !back.allowedTools.includes(AUTO))
    const off = mergeLocalLayer(origin, { allowedTools: [`off:${AUTO_TOOLS[1]}`], permissions: [] })
    assert.deepEqual(off.allowedTools, origin.allowedTools)
  })

  it('⛔ a negação da origem vence a liberação local; o local libera o que a origem não negou', () => {
    const merged = mergeLocalLayer(origin, {
      allowedTools: [],
      permissions: [
        { category: 'terminal', pattern: 'git push *', decision: 'allow' },
        { category: 'terminal', pattern: 'npm test', decision: 'allow' },
      ],
    })
    const verdict = (value: string) => decide({ category: 'terminal', value }, { agent: merged.permissions }).allowed
    assert.equal(verdict('git push origin main'), false)
    assert.equal(verdict('npm test'), true)
    assert.equal(verdict('git status'), true)
  })

  it('a camada guarda só o que esta máquina acrescenta', () => {
    const trimmed = trimLocalLayer(origin, {
      allowedTools: ['mcp:tickets/*', 'mcp:local/*', 'mcp:local/*', AUTO, AUTO_TOOLS[1], `off:${AUTO_TOOLS[1]}`],
      permissions: [
        { category: 'terminal', pattern: 'git status', decision: 'allow' },
        { category: 'terminal', pattern: 'npm test', decision: 'allow' },
      ],
    })
    assert.deepEqual(trimmed, { allowedTools: ['mcp:local/*', AUTO], permissions: [{ category: 'terminal', pattern: 'npm test', decision: 'allow' }] })
    assert.ok(isEmptyLayer(trimLocalLayer(origin, { providers: [], allowedTools: ['agent:atlas'], permissions: [] })))
  })
})
