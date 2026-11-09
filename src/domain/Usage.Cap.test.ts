import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { applyLimits } from './models/Limits.Model'
import { capMessage, capReached, hasCaps, monthStart, usageCaps } from './Usage.Cap'

describe('Usage.Cap', () => {
  afterEach(() => applyLimits(undefined))

  it('o teto vem da tela, senão do .env; -1, zero ou nada = sem teto', () => {
    assert.deepStrictEqual(usageCaps({}), { monthlyCostUsd: undefined, userMonthlyCostUsd: undefined, monthlyTokens: undefined, userMonthlyTokens: undefined })
    assert.strictEqual(hasCaps(usageCaps({})), false)
    assert.strictEqual(usageCaps({ MONTHLY_COST_CAP_USD: '50' }).monthlyCostUsd, 50)
    applyLimits({ monthlyCostCapUsd: 20, userMonthlyTokenCap: -1 })
    assert.strictEqual(usageCaps({ MONTHLY_COST_CAP_USD: '50' }).monthlyCostUsd, 20)
    assert.strictEqual(usageCaps({ USER_MONTHLY_TOKEN_CAP: '5000' }).userMonthlyTokens, undefined)
  })

  it('o do gateway vem antes do da pessoa; alcançar (>=) já bate', () => {
    const caps = { monthlyCostUsd: 10, userMonthlyTokens: 1_000 }
    assert.strictEqual(capReached(caps, { costUsd: 9.99, tokens: 0 }, { costUsd: 0, tokens: 999 }), undefined)
    assert.deepStrictEqual(capReached(caps, { costUsd: 10, tokens: 0 }, { costUsd: 0, tokens: 5_000 }), { scope: 'gateway', kind: 'cost', cap: 10, used: 10 })
    assert.deepStrictEqual(capReached(caps, { costUsd: 1, tokens: 0 }, { costUsd: 0, tokens: 1_000 }), { scope: 'user', kind: 'tokens', cap: 1_000, used: 1_000 })
    assert.strictEqual(capReached({ userMonthlyTokens: 10 }, { costUsd: 0, tokens: 99 }), undefined)
  })

  it('o mês começa no dia 1º em UTC, e a recusa diz qual teto e onde aumentar', () => {
    assert.strictEqual(monthStart(new Date('2026-11-09T15:00:00Z')).toISOString(), '2026-11-01T00:00:00.000Z')
    assert.match(capMessage({ scope: 'user', kind: 'cost', cap: 25, used: 30 }), /^Você atingiu o teto de uso do mês \(US\$ 25\).*Configuração → Limites/)
    assert.match(capMessage({ scope: 'gateway', kind: 'tokens', cap: 1_000_000, used: 1 }), /^O gateway atingiu .*1\.000\.000 tokens/)
  })
})
