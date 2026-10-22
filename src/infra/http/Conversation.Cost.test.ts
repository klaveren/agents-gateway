import assert from 'node:assert'
import { describe, it } from 'node:test'
import { conversationCost, toTurnDto } from './Conversation.Dto'

describe('custo com troca de modelo', () => {
  const pricing = { barato: { input: 1, output: 2 }, caro: { input: 10, output: 20 } }
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000 }

  it('soma modelo a modelo quando a conversa registra o consumo por modelo', () => {
    assert.deepStrictEqual(conversationCost({ model: 'caro', usage: million, usageByModel: { barato: million, caro: million } }, pricing), { costUsd: 33, costIsFloor: undefined })
  })

  it('conversa antiga (sem consumo por modelo): o modelo da conversa com o consumo inteiro', () => {
    assert.deepStrictEqual(conversationCost({ model: 'barato', usage: million }, pricing), { costUsd: 3, costIsFloor: undefined })
  })

  it('⚠️ modelo sem preço não vira zero: fica de fora e o total é piso', () => {
    assert.deepStrictEqual(conversationCost({ model: 'x', usage: million, usageByModel: { barato: million, semPreco: million } }, pricing), { costUsd: 3, costIsFloor: true })
    assert.deepStrictEqual(conversationCost({ model: 'semPreco', usage: million }, pricing), {})
  })

  it('o turno é precificado pelo SEU modelo; o antigo, pelo da conversa', () => {
    const view = { admin: true, pricingOf: () => pricing }
    const turn = { sessionId: 's', index: 0, at: new Date(), request: '', text: '', toolCalls: [], usage: million }

    assert.strictEqual(toTurnDto({ ...turn, model: 'caro' }, { provider: 'p', model: 'barato' }, view).costUsd, 30)
    assert.strictEqual(toTurnDto(turn, { provider: 'p', model: 'barato' }, view).costUsd, 3)
  })
})
