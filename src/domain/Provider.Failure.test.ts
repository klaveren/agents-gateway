import assert from 'node:assert'
import { describe, it } from 'node:test'
import { errorPayload, failureKind } from './Provider.Failure'

describe('Provider.Failure — por que o provedor falhou', () => {
  it('cota e limite de plano, nas palavras de cada provedor', () => {
    for (const message of [
      'You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
      '429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content',
      "You've hit your usage limit. Upgrade to Pro or try again in 3 hours.",
      'Claude AI usage limit reached|1793330000',
      'Your credit balance is too low to access the Anthropic API.',
    ])
      assert.strictEqual(failureKind(new Error(message)), 'quota', message)
  })

  it('limite de taxa pelo status ou pelo texto; sobrecarga; credencial; o resto', () => {
    assert.strictEqual(failureKind(Object.assign(new Error('Too Many Requests'), { status: 429 })), 'rate_limit')
    assert.strictEqual(failureKind('rate_limit_error: Number of request tokens has exceeded your per-minute rate limit'), 'rate_limit')
    assert.strictEqual(failureKind(Object.assign(new Error('Overloaded'), { status: 529 })), 'overloaded')
    assert.strictEqual(failureKind(Object.assign(new Error('invalid x-api-key'), { status: 401 })), 'auth')
    assert.strictEqual(failureKind(new Error('model not found')), 'other')
  })

  it('o payload leva o kind e quando a cota volta, e não leva kind quando não diz nada', () => {
    const reset = errorPayload(Object.assign(new Error('usage limit reached (five_hour)'), { resetsAt: 1_793_330_000 }))
    assert.strictEqual(reset.kind, 'quota')
    assert.strictEqual(reset.resetsAt, new Date(1_793_330_000_000).toISOString())
    assert.deepStrictEqual(errorPayload(new Error('boom'), 'Falhou'), { message: 'Falhou' })
  })
})
