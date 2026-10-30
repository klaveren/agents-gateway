import assert from 'node:assert'
import { describe, it } from 'node:test'
import { equivalentPrice } from './Subscription.Client'

describe('equivalentPrice — o preço da API, mesmo na assinatura', () => {
  const pricing = { 'claude-opus-5': { input: 5, output: 25 }, 'claude-sonnet-5': { input: 2, output: 10 }, 'gpt-5.6-sol': { input: 1, output: 8 } }

  it('id exato, id com o nível do Antigravity no fim, e a família mais próxima', () => {
    assert.deepStrictEqual(equivalentPrice('gpt-5.6-sol', pricing), { input: 1, output: 8 })
    assert.deepStrictEqual(equivalentPrice('claude-sonnet-5-5-high', pricing), { input: 2, output: 10 })
    assert.deepStrictEqual(equivalentPrice('claude-opus-5-5', pricing), { input: 5, output: 25 })
  })

  it('sem nada parecido, sem preço — nunca zero', () => {
    assert.strictEqual(equivalentPrice('gemini-4-argon-high', pricing), undefined)
  })
})
