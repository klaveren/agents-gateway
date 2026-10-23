import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { applyLimits, liveLimit, normalizeLimits } from './Limits.Model'
import { mergeSettings, normalizeSettings } from './Settings.Model'
import { delegationMaxDepth } from './Delegation.Model'

describe('Limits', () => {
  afterEach(() => applyLimits(undefined))

  it('normaliza: só inteiros dentro da faixa', () => {
    assert.deepStrictEqual(normalizeLimits({ maxToolTurns: 20, maxOutputTokens: 1.5, delegationMaxDepth: 99, outro: 3 }), { maxToolTurns: 20 })
    assert.strictEqual(normalizeLimits({ maxToolTurns: 0 }), undefined)
    assert.strictEqual(normalizeLimits('x'), undefined)
    assert.deepStrictEqual(normalizeSettings({ audience: 'all', limits: { streamsPerOwner: 5 } }).limits, { streamsPerOwner: 5 })
  })

  it('a gravação mescla limite a limite; null volta ao .env, e null no objeto volta todos', () => {
    const current = { audience: 'all' as const, limits: { maxToolTurns: 20, sessionsPerOwner: 10 } }

    assert.deepStrictEqual(mergeSettings(current, { limits: { maxToolTurns: 30 } }).limits, { maxToolTurns: 30, sessionsPerOwner: 10 })
    assert.deepStrictEqual(mergeSettings(current, { limits: { maxToolTurns: null } }).limits, { sessionsPerOwner: 10 })
    assert.strictEqual(mergeSettings(current, { limits: null }).limits, undefined)
    assert.strictEqual(mergeSettings(current, { limits: { maxToolTurns: null, sessionsPerOwner: null } }).limits, undefined)
  })

  it('o que está na tela vence o .env, e vale na hora', () => {
    const env = { DELEGATION_MAX_DEPTH: '3' }
    assert.strictEqual(delegationMaxDepth(env), 3)

    applyLimits({ delegationMaxDepth: 0 })
    assert.strictEqual(liveLimit('delegationMaxDepth'), 0)
    assert.strictEqual(delegationMaxDepth(env), 0)

    applyLimits(undefined)
    assert.strictEqual(delegationMaxDepth(env), 3)
  })
})
