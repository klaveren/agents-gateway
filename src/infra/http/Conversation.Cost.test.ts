import assert from 'node:assert'
import { describe, it } from 'node:test'
import { conversationCost, toTurnDto } from './Conversation.Dto'

describe('custo com troca de modelo', () => {
  const prices = { barato: { input: 1, output: 2 }, caro: { input: 10, output: 20 } }
  const pricing = () => prices
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000 }

  it('soma modelo a modelo quando a conversa registra o consumo por modelo', () => {
    assert.deepStrictEqual(conversationCost({ provider: 'p', model: 'caro', usage: million, usageByModel: { 'p|barato': million, 'p|caro': million } }, pricing), {
      costUsd: 33,
      costIsFloor: undefined,
    })
  })

  it('conversa antiga (sem consumo por modelo): o modelo da conversa com o consumo inteiro', () => {
    assert.deepStrictEqual(conversationCost({ provider: 'p', model: 'barato', usage: million }, pricing), { costUsd: 3, costIsFloor: undefined })
  })

  it('⚠️ modelo sem preço não vira zero: fica de fora e o total é piso', () => {
    assert.deepStrictEqual(conversationCost({ provider: 'p', model: 'x', usage: million, usageByModel: { 'p|barato': million, 'p|semPreco': million } }, pricing), {
      costUsd: 3,
      costIsFloor: true,
    })
    assert.deepStrictEqual(conversationCost({ provider: 'p', model: 'semPreco', usage: million }, pricing), {})
  })

  it('o turno é precificado pelo SEU modelo; o antigo, pelo da conversa', () => {
    const view = { admin: true, pricingOf: pricing }
    const turn = { sessionId: 's', index: 0, at: new Date(), request: '', text: '', toolCalls: [], usage: million }

    assert.strictEqual(toTurnDto({ ...turn, model: 'caro' }, { provider: 'p', model: 'barato' }, view).costUsd, 30)
    assert.strictEqual(toTurnDto(turn, { provider: 'p', model: 'barato' }, view).costUsd, 3)
  })

  it('com troca de provider, cada entrada pela tabela do SEU provider; a chave antiga (só o modelo) é do provider da conversa', () => {
    const byProvider = (provider: string) => (provider === 'sub' ? { caro: { input: 0, output: 0 } } : prices)
    assert.deepStrictEqual(conversationCost({ provider: 'p', model: 'caro', usage: million, usageByModel: { 'sub|caro': million, caro: million } }, byProvider), {
      costUsd: 30,
      costIsFloor: undefined,
    })
  })

  it('o turno é precificado pelo SEU provider', () => {
    const byProvider = (provider: string) => (provider === 'sub' ? { caro: { input: 0, output: 0 } } : prices)
    const turn = { sessionId: 's', index: 0, at: new Date(), request: '', text: '', toolCalls: [], usage: million, model: 'caro' }
    assert.strictEqual(toTurnDto({ ...turn, provider: 'sub' }, { provider: 'p' }, { admin: true, pricingOf: byProvider }).costUsd, 0)
    assert.strictEqual(toTurnDto(turn, { provider: 'p' }, { admin: true, pricingOf: byProvider }).costUsd, 30)
  })
})
