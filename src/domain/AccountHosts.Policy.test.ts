import assert from 'node:assert'
import { describe, it } from 'node:test'
import { accountOpensHost } from './AccountHosts.Policy'
import { decide } from './Permission.Policy'

const hosts = ['github.com:443', 'api.github.com:443']
const verdict = (layers: Parameters<typeof decide>[1]) => decide({ category: 'network', value: 'github.com:443' }, layers)

describe('AccountHosts.Policy', () => {
  it('sem regra de rede, o host da conta liberada abre; outro host e outra porta não', () => {
    assert.ok(accountOpensHost(verdict({}), hosts, 'github.com', 443))
    assert.ok(accountOpensHost(verdict({}), hosts, 'API.github.com', 443))
    assert.ok(!accountOpensHost(verdict({}), hosts, 'evil.com', 443))
    assert.ok(!accountOpensHost(verdict({}), hosts, 'github.com', 22))
    assert.ok(!accountOpensHost(verdict({}), undefined, 'github.com', 443))
  })

  it('Negar explícito de rede vence a conta; regra que já libera não precisa dela', () => {
    assert.ok(!accountOpensHost(verdict({ project: [{ category: 'network', pattern: 'github.com', decision: 'deny' }] }), hosts, 'github.com', 443))
    assert.ok(!accountOpensHost(verdict({ agent: [{ category: 'network', pattern: 'github.com', decision: 'allow' }] }), hosts, 'github.com', 443))
  })
})
