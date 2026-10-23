import assert from 'node:assert'
import { describe, it } from 'node:test'
import { isMetaHost, resolveAllowedHosts } from '@infra/sandbox/Egress.Proxy'
import { clientMetadata } from './Session.Metadata'

describe('clientMetadata — o que o cliente pode declarar', () => {
  it('⛔ dono e delegação vindos do corpo saem; quem não é admin perde as chaves do egresso', () => {
    const declared = { accountId: 'a1', owner: { id: 'root' }, delegationDepth: -1000, delegationChain: [], delegatedBy: 'x', siteDomain: 'evil.example' }
    assert.deepStrictEqual(clientMetadata(declared, { admin: false, protectedKeys: ['siteDomain'] }).metadata, { accountId: 'a1' })
    assert.deepStrictEqual(clientMetadata(declared, { admin: true, protectedKeys: ['siteDomain'] }).metadata, { accountId: 'a1', siteDomain: 'evil.example' })
  })

  it('teto de chaves e de tamanho', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, 1]))
    assert.strictEqual(clientMetadata(many, { admin: true, protectedKeys: [] }).issues.length, 1)
    assert.strictEqual(clientMetadata({ big: 'x'.repeat(9000) }, { admin: true, protectedKeys: [] }).issues.length, 1)
  })
})

describe('{meta:} do egresso', () => {
  it('⛔ só host de verdade: `com` sozinho liberaria `*.com`', () => {
    assert.ok(isMetaHost('cliente.com.br'))
    assert.ok(!isMetaHost('com'))
    assert.ok(!isMetaHost('10.0.0.1'))
    assert.ok(!isMetaHost('a..b'))
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:site}'], { site: 'com' }), [])
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:site}'], { site: 'example.com' }), ['example.com'])
  })
})
