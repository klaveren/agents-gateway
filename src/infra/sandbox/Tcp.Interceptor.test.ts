import assert from 'node:assert'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { exactTcpTarget } from '@infra/tools/Local.Tools'
import { tcpInterceptor } from './Project.Sandbox'

describe('TCP fora do HTTP pelo portão (proxychains)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-tcp-'))
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('só regra EXATA de TCP fora do HTTP liga o interceptador; o localhost tem encaminhador próprio', () => {
    for (const pattern of ['10.10.0.1:32017', 'db.interno:5432', 'k3s.lan:22', '[fd00::1]:6443']) assert.strictEqual(exactTcpTarget(pattern), true, pattern)
    for (const pattern of ['*.github.com', 'api.github.com:443', 'site.com:80', '10.10.0.*:22', 'localhost:27017', '127.0.0.1:5432', 'sem-porta.com'])
      assert.strictEqual(exactTcpTarget(pattern), false, pattern)
  })

  it('⛔ o prelúdio leva TUDO pelo CONNECT da ponte com o token do comando, menos o loopback; sem a biblioteca, nada', () => {
    const lib = join(dir, 'libproxychains.so.4')
    writeFileSync(lib, '')
    const prelude = tcpInterceptor(dir, 'tok-abcdef1234567890xyz', 3128, [lib])
    assert.match(prelude, new RegExp(`LD_PRELOAD='?${lib.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`))
    const conf = /PROXYCHAINS_CONF_FILE='?([^' ]+)/.exec(prelude)![1]
    const text = readFileSync(conf, 'utf8')
    assert.match(text, /^strict_chain$/m)
    assert.match(text, /^proxy_dns$/m)
    assert.match(text, /^localnet 127\.0\.0\.0\/255\.0\.0\.0$/m)
    assert.match(text, /^http 127\.0\.0\.1 3128 tok-abcdef1234567890xyz x$/m)
    assert.strictEqual(tcpInterceptor(dir, 'tok', 3128, [join(dir, 'nao-existe.so')]), '')
  })
})
