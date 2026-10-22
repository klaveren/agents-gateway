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
    provider: EProvider.CLAUDE,
    systemPrompt: 'x',
    models: ['raciocina', 'parcial', 'nao-raciocina', 'desconhecido'],
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
    const dto = toAgentDto(agent(), {}, false, { protocol: EProvider.CLAUDE, reasoningOf: (model) => catalog[model] })

    assert.deepStrictEqual(dto.reasoningEfforts, ['low', 'high', 'max'])
    assert.deepStrictEqual(dto.modelReasoning, { raciocina: ['low', 'high', 'max'], parcial: ['low'], 'nao-raciocina': [], desconhecido: null })
  })

  it('nível gravado que o protocolo não aceita some (um agente Google antigo não oferece raciocínio)', () => {
    const dto = toAgentDto(agent({ provider: EProvider.GOOGLE, models: ['gemini'], reasoningEfforts: ['low'] }), {}, false, { protocol: EProvider.GOOGLE })

    assert.strictEqual(dto.reasoningEfforts, undefined)
    assert.deepStrictEqual(dto.modelReasoning, { gemini: [] })
  })
})
