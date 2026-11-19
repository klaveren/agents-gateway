import { describe, expect, it } from 'vitest'
import { choiceKey, levelsOf, offers, parseChoice, resolveChoice, withAllowedModels } from './agentChoice'
import type { IAgent } from './types'

const agent: Pick<IAgent, 'providers' | 'reasoningEfforts'> = {
  providers: [
    { id: 'claude', name: 'Claude', models: ['opus', 'sonnet'], pricing: {}, reasoningEfforts: ['low', 'high'], modelReasoning: { opus: ['low', 'high'], sonnet: null } },
    { id: 'claude-sub', name: 'Claude (assinatura)', models: ['opus'], pricing: {}, reasoningEfforts: ['low'], modelReasoning: { opus: ['low'] } },
  ],
  reasoningEfforts: ['low', 'high'],
}

describe('agentChoice', () => {
  it('a chave do select ida e volta, com barra no id do modelo', () => {
    expect(parseChoice(choiceKey({ provider: 'openrouter', model: 'anthropic/claude' }))).toEqual({ provider: 'openrouter', model: 'anthropic/claude' })
    expect(parseChoice('sem-separador')).toBeUndefined()
  })

  it('oferece só o par que o agente declara', () => {
    expect(offers(agent, { provider: 'claude-sub', model: 'opus' })).toBe(true)
    expect(offers(agent, { provider: 'claude-sub', model: 'sonnet' })).toBe(false)
  })

  it('resolve o pedido, o modelo no primeiro provider que o tem, ou o padrão', () => {
    expect(resolveChoice(agent, { provider: 'claude-sub', model: 'opus' })).toEqual({ provider: 'claude-sub', model: 'opus' })
    expect(resolveChoice(agent, { model: 'opus' })).toEqual({ provider: 'claude', model: 'opus' })
    expect(resolveChoice(agent, {})).toEqual({ provider: 'claude', model: 'opus' })
    expect(resolveChoice({ providers: [] })).toBeUndefined()
  })

  it('os níveis são do modelo NAQUELE provider; catálogo que não sabe usa os do provider', () => {
    expect(levelsOf(agent, { provider: 'claude', model: 'opus' })).toEqual(['low', 'high'])
    expect(levelsOf(agent, { provider: 'claude-sub', model: 'opus' })).toEqual(['low'])
    expect(levelsOf(agent, { provider: 'claude', model: 'sonnet' })).toEqual(['low', 'high'])
    expect(levelsOf(agent, undefined)).toEqual([])
  })
})

describe('🔐 withAllowedModels', () => {
  const base = {
    providers: [
      { id: 'claude', name: 'Claude', models: ['opus', 'haiku'], pricing: {} },
      { id: 'codex', name: 'Codex', models: ['sol'], pricing: {} },
    ],
  } as never
  it('sem lista, o agente como está; com lista, só os liberados (e some o provider sem nenhum)', () => {
    expect(withAllowedModels(base, null)).toBe(base)
    const filtered = withAllowedModels(base, ['claude/haiku']) as { providers: Array<{ id: string; models: string[] }> }
    expect(filtered.providers.map((provider) => [provider.id, provider.models])).toEqual([['claude', ['haiku']]])
  })
  it('nenhum liberado: fica indisponível, com o motivo', () => {
    expect((withAllowedModels(base, ['outro/x']) as { unavailable?: { label: string } }).unavailable?.label).toMatch(/neste projeto/)
  })
})
