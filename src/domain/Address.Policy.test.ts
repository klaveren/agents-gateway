import assert from 'node:assert'
import { describe, it } from 'node:test'
import { classifyAddress } from './Address.Policy'

describe('Address.Policy — classifyAddress', () => {
  it('⛔ IPv6 mapeado em qualquer grafia vale o IPv4 dentro dele', () => {
    const cases: Array<[string, string]> = [
      ['::ffff:7f00:1', 'loopback'],
      ['::ffff:127.0.0.1', 'loopback'],
      ['0:0:0:0:0:ffff:7f00:1', 'loopback'],
      ['[::FFFF:7F00:1]', 'loopback'],
      ['::ffff:a9fe:a9fe', 'linklocal'],
      ['::ffff:169.254.169.254', 'linklocal'],
      ['::ffff:c0a8:101', 'private'],
      ['::ffff:a00:1', 'private'],
      ['::ffff:808:808', 'public'],
      ['0:0:0:0:0:0:0:1', 'loopback'],
      ['::1', 'loopback'],
      ['::', 'unspecified'],
      ['0:0:0:0:0:0:0:0', 'unspecified'],
      ['::7f00:1', 'loopback'],
      ['::8.8.8.8', 'private'],
      ['64:ff9b::7f00:1', 'loopback'],
      ['64:ff9b::808:808', 'private'],
      ['2002:a9fe:a9fe::1', 'linklocal'],
      ['2002:808:808::1', 'private'],
      ['2001:0:4136:e378::1', 'private'],
      ['fe80::1', 'linklocal'],
      ['febf::1', 'linklocal'],
      ['fd00:ec2::254', 'linklocal'],
      ['fc00::1', 'private'],
      ['fdab::1', 'private'],
      ['ff02::1', 'private'],
      ['2606:4700:4700::1111', 'public'],
    ]
    for (const [address, kind] of cases) assert.strictEqual(classifyAddress(address), kind, address)
  })

  it('IPv4: loopback, link-local, 0/8, RFC1918, CGNAT, multicast; o resto é público', () => {
    const cases: Array<[string, string]> = [
      ['127.0.0.1', 'loopback'],
      ['127.9.9.9', 'loopback'],
      ['169.254.169.254', 'linklocal'],
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'unspecified'],
      ['10.0.0.1', 'private'],
      ['172.16.0.1', 'private'],
      ['172.31.255.255', 'private'],
      ['172.32.0.1', 'public'],
      ['192.168.1.1', 'private'],
      ['100.64.0.1', 'private'],
      ['100.128.0.1', 'public'],
      ['224.0.0.1', 'private'],
      ['255.255.255.255', 'private'],
      ['8.8.8.8', 'public'],
    ]
    for (const [address, kind] of cases) assert.strictEqual(classifyAddress(address), kind, address)
  })

  it('o que não é IP é inválido', () => {
    for (const value of ['', 'localhost', '1.2.3', '256.1.1.1', ':::', '1::2::3', 'g::1', '1:2:3:4:5:6:7:8:9']) assert.strictEqual(classifyAddress(value), 'invalid', value)
  })
})
