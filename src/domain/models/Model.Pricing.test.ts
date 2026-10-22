import assert from 'node:assert'
import { describe, it } from 'node:test'
import { AGENT_REGISTRY } from '../Agent.Registry'
import { costOf, MODEL_PRICING, mergePricing, outputPriceOf } from './Model.Pricing'

describe('costOf', () => {
  it('cobra o cache pelo preço dele e a entrada nova pelo preço de entrada', () => {
    // gemini-3.7-flash: entrada $0,75, cache lido $0,075, saída $3,75 por 1M.
    const cost = costOf('gemini-3.7-flash', { inputTokens: 1_000_000, cacheReadTokens: 400_000, outputTokens: 100_000, reasoningTokens: 100_000 })

    assert.ok(cost !== undefined)
    assert.strictEqual(cost.toFixed(4), (0.6 * 0.75 + 0.4 * 0.075 + 0.2 * 3.75).toFixed(4))
  })

  it('o cache é parcela da entrada: não se cobra duas vezes', () => {
    // Tudo veio do cache: nada de entrada nova.
    assert.strictEqual(costOf('claude-sonnet-5', { inputTokens: 1_000_000, cacheReadTokens: 1_000_000 })?.toFixed(2), '0.20')
  })

  it('gravação de cache tem preço próprio onde é cobrada', () => {
    assert.strictEqual(costOf('claude-sonnet-5', { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000 })?.toFixed(2), '2.50')
  })

  it('o raciocínio é cobrado como saída', () => {
    const visible = costOf('claude-opus-5', { outputTokens: 1_000_000 })
    const thinking = costOf('claude-opus-5', { reasoningTokens: 1_000_000 })

    assert.strictEqual(visible, 25)
    assert.strictEqual(thinking, visible)
  })

  it('cache maior que a entrada não gera custo negativo', () => {
    assert.strictEqual(costOf('claude-opus-5', { inputTokens: 100, cacheReadTokens: 500 })! >= 0, true)
  })

  it('modelo sem preço não custa zero: fica sem custo', () => {
    assert.strictEqual(costOf('modelo-desconhecido', { inputTokens: 1000 }), undefined)
    assert.strictEqual(costOf('toString', { inputTokens: 1000 }), undefined, 'nome herdado do Object não é modelo')
  })

  it('usa a tabela recebida, quando há', () => {
    assert.strictEqual(costOf('x', { inputTokens: 1_000_000 }, { x: { input: 3, output: 4 } }), 3)
  })

  it('todo modelo da tabela tem preço de leitura de cache', () => {
    for (const [model, price] of Object.entries(MODEL_PRICING)) assert.ok(price.cacheRead !== undefined, `${model} sem cacheRead`)
  })

  it('só traz preço de modelo que o registro declara, e deixa de fora o que não foi conferido', () => {
    const declared = new Set(AGENT_REGISTRY.flatMap((agent) => agent.models))

    assert.ok(Object.keys(MODEL_PRICING).every((model) => declared.has(model)))
    assert.strictEqual(MODEL_PRICING['o4-mini'], undefined)
    assert.strictEqual(MODEL_PRICING['o3-pro'], undefined)
  })
})

describe('outputPriceOf', () => {
  it('ordena do mais barato, e o sem preço vai para o fim', () => {
    assert.ok(outputPriceOf('gemini-3.7-flash') < outputPriceOf('claude-opus-5'))
    assert.strictEqual(outputPriceOf('o3-pro'), Number.POSITIVE_INFINITY)
  })
})

describe('mergePricing', () => {
  it('soma modelo novo e substitui o de fábrica inteiro, sem mesclar campos', () => {
    const { pricing, problems } = mergePricing({ 'o4-mini': { input: 1, output: 4 }, 'claude-sonnet-5': { input: 9, output: 9 } })

    assert.deepStrictEqual(problems, [])
    assert.deepStrictEqual(pricing['o4-mini'], { input: 1, output: 4 })
    assert.deepStrictEqual(pricing['claude-sonnet-5'], { input: 9, output: 9 }, 'cacheRead de fábrica não sobrevive')
    assert.deepStrictEqual(pricing['claude-opus-5'], MODEL_PRICING['claude-opus-5'])
  })

  it('não altera a tabela de fábrica', () => {
    mergePricing({ 'claude-sonnet-5': { input: 99, output: 99 } })

    assert.strictEqual(MODEL_PRICING['claude-sonnet-5'].input, 2)
  })

  it('uma entrada inválida recusa TUDO e volta às de fábrica', () => {
    const { pricing, problems } = mergePricing({ ok: { input: 1, output: 1 }, ruim: { input: -1, output: 'x' }, sem: {} })

    assert.strictEqual(pricing, MODEL_PRICING)
    assert.strictEqual(pricing.ok, undefined)
    assert.ok(problems.length >= 3)
  })

  it('recusa o que não é objeto', () => {
    for (const raw of [null, [], 'x', 3]) assert.ok(mergePricing(raw).problems.length > 0)
  })

  it('introductoryUntil precisa ser uma data', () => {
    assert.ok(mergePricing({ x: { input: 1, output: 1, introductoryUntil: 'em breve' } }).problems.length > 0)
    assert.deepStrictEqual(mergePricing({ x: { input: 1, output: 1, introductoryUntil: '2027-01-01' } }).problems, [])
  })
})
