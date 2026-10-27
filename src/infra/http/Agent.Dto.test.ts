import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IModelReasoning } from '@domain/models/ModelCatalog.Model'
import { toAgentDto } from './Agent.Dto'

describe('toAgentDto — raciocínio', () => {
  const agent = (over: Partial<IAgent> = {}): IAgent => ({
    id: 'a',
    name: 'A',
    providers: [{ provider: EProvider.CLAUDE, models: ['raciocina', 'parcial', 'nao-raciocina', 'desconhecido'] }],
    systemPrompt: 'x',
    reasoningEfforts: ['high', 'low', 'max'],
    modes: [EMode.CHAT],
    allowedTools: [],
    ...over,
  })

  const catalog: Record<string, IModelReasoning> = {
    raciocina: { supported: true, source: 'provider' },
    parcial: { supported: true, levels: ['low', 'medium'], source: 'provider' },
    'nao-raciocina': { supported: false, source: 'provider' },
  }

  it('cruza os níveis do agente (na ordem do protocolo) com o que o catálogo sabe de cada modelo', () => {
    const dto = toAgentDto(agent(), () => ({ protocol: EProvider.CLAUDE, reasoningOf: (model: string) => catalog[model] }))

    assert.deepStrictEqual(dto.providers[0].reasoningEfforts, ['low', 'high', 'max'])
    assert.deepStrictEqual(dto.providers[0].modelReasoning, { raciocina: ['low', 'high', 'max'], parcial: ['low'], 'nao-raciocina': [], desconhecido: null })
  })

  it('nível gravado que o protocolo não aceita some (um agente Google antigo não oferece raciocínio)', () => {
    const dto = toAgentDto(agent({ providers: [{ provider: EProvider.GOOGLE, models: ['gemini'] }], reasoningEfforts: ['low'] }), () => ({ protocol: EProvider.GOOGLE }))

    assert.strictEqual(dto.providers[0].reasoningEfforts, undefined)
    assert.deepStrictEqual(dto.providers[0].modelReasoning, { gemini: [] })
  })

  it('a janela de contexto de cada modelo vai junto, só a dos que o catálogo conhece', () => {
    const sizes: Record<string, number> = { raciocina: 200_000, parcial: 1_000_000 }
    const dto = toAgentDto(agent(), () => ({ protocol: EProvider.CLAUDE, contextOf: (model: string) => sizes[model] }))
    assert.deepStrictEqual(dto.providers[0].contextLength, { raciocina: 200_000, parcial: 1_000_000 })
  })
})
