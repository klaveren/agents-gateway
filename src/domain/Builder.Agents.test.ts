import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from './enums/EMode.Enum'
import { builderAgent, builderAgentId, builderKindOf, CORE_AGENT_IDS, PROPOSE_DRAFT_TOOL } from './Builder.Agents'

describe('Builder.Agents', () => {
  it('um construtor por tipo, só de admin, só na lane agent, com o protocolo do core no prompt', () => {
    const agent = builderAgent('command', { provider: 'claude', models: ['claude-sonnet-5'] })
    assert.deepStrictEqual([agent.id, agent.adminOnly, agent.modes], ['builder-command', true, [EMode.AGENT]])
    assert.deepStrictEqual(agent.providers, [{ provider: 'claude', models: ['claude-sonnet-5'] }])
    assert.ok(agent.allowedTools.includes(PROPOSE_DRAFT_TOOL))
    assert.match(agent.systemPrompt, /# Protocolo de construção de command[\s\S]*\$ARGUMENTS/)
  })

  it('os ids reservados e o caminho de volta, do id ao tipo', () => {
    assert.deepStrictEqual(CORE_AGENT_IDS, ['builder-skill', 'builder-command'])
    assert.deepStrictEqual([builderKindOf(builderAgentId('skill')), builderKindOf('atlas'), builderKindOf(undefined)], ['skill', undefined, undefined])
  })
})
