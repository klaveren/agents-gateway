import assert from 'node:assert'
import { describe, it } from 'node:test'
import { containerArgs } from './Docker.Sandbox'
import { egressProxySource, hostAllowed, isPrivateAddress, portAllowed, resolveAllowedHosts } from './Egress.Proxy'

describe('Egress.Proxy', () => {
  it('a lista aceita o domínio e os subdomínios dele, e mais nada', () => {
    assert.ok(hostAllowed('example.com', ['example.com']))
    assert.ok(hostAllowed('WWW.Example.com.', ['example.com']))
    assert.ok(hostAllowed('a.b.example.com', ['*.example.com']))
    assert.ok(!hostAllowed('example.com.evil.io', ['example.com']))
    assert.ok(!hostAllowed('notexample.com', ['example.com']))
    assert.ok(!hostAllowed('example.com', []))
  })

  it('⛔ endereço privado, loopback, link-local, CGNAT e afins nunca passam (o host do gateway e a LAN)', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.65.254',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '[::1]',
    ]) {
      assert.ok(isPrivateAddress(ip), ip)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '172.32.0.1']) assert.ok(!isPrivateAddress(ip), ip)
  })

  it('só as portas 80 e 443', () => {
    assert.deepStrictEqual([80, 443, 22, 3100, 5432].map(portAllowed), [true, true, false, false, false])
  })

  it('{meta:chave} vira o valor da conversa; sem valor, some (nunca "libera tudo")', () => {
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:siteDomain}', 'cdn.exemplo.com'], { siteDomain: 'cliente.com.br' }), ['cliente.com.br', 'cdn.exemplo.com'])
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:siteDomain}'], {}), [])
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:siteDomain}'], { siteDomain: 'x.com; rm -rf' }), [])
    assert.deepStrictEqual(resolveAllowedHosts(['{meta:sites}'], { sites: ['a.com', 'b.com'] }), ['a.com', 'b.com'])
  })

  it('o script do proxy é JavaScript válido e embute as mesmas regras', () => {
    const source = egressProxySource()
    assert.doesNotThrow(() => new Function('require', 'process', source.replace(/server\.listen\([\s\S]*$/, '')))
    assert.ok(source.includes('isPrivateAddress') && source.includes('hostAllowed'))
  })
})

describe('containerArgs', () => {
  const base = {
    image: 'mcr.microsoft.com/playwright/mcp:latest',
    args: ['--isolated', '--proxy-server={proxy}'],
    writable: ['/home/node'],
    memoryMb: 1024,
    cpus: 1,
    envNames: ['API_TOKEN'],
    serverId: 'pw',
    instance: 'abc',
  }

  it('⛔ as travas estão sempre lá; nunca volume, porta publicada, privilégio nem a rede do host', () => {
    const args = containerArgs({ ...base, network: { mode: 'none' } })
    for (const flag of ['--rm', '--init', '--read-only']) assert.ok(args.includes(flag), flag)
    assert.deepStrictEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL'])
    assert.ok(args.includes('no-new-privileges'))
    assert.deepStrictEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'none'])
    for (const flag of ['-v', '--volume', '--mount', '-p', '--publish', '--privileged', 'host']) assert.ok(!args.includes(flag), flag)
  })

  it('⛔ o valor da variável secreta nunca vai na linha de comando — só o nome', () => {
    const args = containerArgs({ ...base, network: { mode: 'none' } })
    assert.deepStrictEqual(args.slice(args.indexOf('API_TOKEN') - 1, args.indexOf('API_TOKEN') + 1), ['-e', 'API_TOKEN'])
  })

  it('com allowlist: a rede interna, o proxy no ambiente e o {proxy} nos argumentos', () => {
    const args = containerArgs({ ...base, network: { mode: 'allowlist', name: 'gw-net', proxyUrl: 'http://gw-egress:3128' } })
    assert.deepStrictEqual(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2), ['--network', 'gw-net'])
    assert.ok(args.includes('HTTPS_PROXY=http://gw-egress:3128'))
    assert.ok(args.includes('--proxy-server=http://gw-egress:3128'))
  })
})

describe('isPrivateAddress — túneis IPv6', () => {
  it('⛔ 6to4, Teredo e NAT64 (embutem um IPv4 da rede interna) são privados', async () => {
    const { isPrivateAddress } = await import('./Egress.Proxy')
    for (const address of ['2002:c0a8:0101::1', '2001:0:4136:e378::1', '64:ff9b::a00:1']) assert.ok(isPrivateAddress(address), address)
    assert.ok(!isPrivateAddress('2606:4700:4700::1111'))
  })
})
