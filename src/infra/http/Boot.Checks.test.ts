import assert from 'node:assert'
import { describe, it } from 'node:test'
import { bootIssues } from './Boot.Checks'

describe('bootIssues', () => {
  it('⛔ anônimo fora do loopback e segredo curto impedem o boot', () => {
    assert.deepStrictEqual(bootIssues({ ALLOW_ANONYMOUS: '1' }), [])
    assert.strictEqual(bootIssues({ ALLOW_ANONYMOUS: '1', HOST: '0.0.0.0' }).length, 1)
    assert.strictEqual(bootIssues({ AUTH_SECRET: 'curto' }).length, 1)
    assert.deepStrictEqual(bootIssues({ AUTH_SECRET: 'x'.repeat(32), HOST: '0.0.0.0' }), [])
  })
})
