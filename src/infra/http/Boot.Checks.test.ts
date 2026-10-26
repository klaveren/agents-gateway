import assert from 'node:assert'
import { describe, it } from 'node:test'
import { bootIssues, bootWarnings } from './Boot.Checks'

describe('bootIssues', () => {
  it('⛔ anônimo fora do loopback e segredo curto impedem o boot', () => {
    assert.deepStrictEqual(bootIssues({ ALLOW_ANONYMOUS: '1' }), [])
    assert.strictEqual(bootIssues({ ALLOW_ANONYMOUS: '1', HOST: '0.0.0.0' }).length, 1)
    assert.strictEqual(bootIssues({ AUTH_SECRET: 'curto' }).length, 1)
    assert.deepStrictEqual(bootIssues({ AUTH_SECRET: 'x'.repeat(32), HOST: '0.0.0.0' }), [])
  })
})

describe('bootWarnings', () => {
  it('⚠️ GATEWAY_TOKEN definido avisa que não protege mais nada, sem impedir o boot', () => {
    assert.deepStrictEqual(bootWarnings({}), [])
    assert.match(bootWarnings({ GATEWAY_TOKEN: 's3cret' })[0], /GATEWAY_TOKEN no longer has any effect/)
    assert.deepStrictEqual(bootIssues({ GATEWAY_TOKEN: 's3cret' }), [])
  })
})
