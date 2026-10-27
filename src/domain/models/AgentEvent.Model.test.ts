import assert from 'node:assert'
import { describe, it } from 'node:test'
import { addUsage } from './AgentEvent.Model'

describe('addUsage', () => {
  it('⚖️ soma o consumo campo a campo, mas o contexto em uso é o da chamada mais recente — nunca a soma', () => {
    const turn = addUsage({ inputTokens: 1000, outputTokens: 10, contextTokens: 1000 }, { inputTokens: 1200, outputTokens: 30, contextTokens: 1200 })
    assert.deepStrictEqual(turn, { inputTokens: 2200, outputTokens: 40, contextTokens: 1200 })
    // Chamada que não informa o contexto (Codex) não o apaga.
    assert.strictEqual(addUsage(turn, { inputTokens: 5 }).contextTokens, 1200)
    assert.strictEqual(addUsage({}, { inputTokens: 5 }).contextTokens, undefined)
  })
})
