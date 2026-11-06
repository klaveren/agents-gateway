import assert from 'node:assert'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { addressKind, NetworkGate, preferredAddress } from './Network.Gate'

/** Um CONNECT cru na porta, com ou sem token; devolve a linha de status da resposta. */
function connectThrough(port: number, target: string, token?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    })
    socket.once('data', (chunk) => (resolve(chunk.toString('utf8').split('\r\n')[0]), socket.destroy()))
    socket.once('error', reject)
  })
}

describe('Network.Gate', () => {
  const gate = new NetworkGate()
  let port = 0
  before(async () => (port = await gate.start()))
  after(() => gate.stop())

  it('sem token (ou com um que já morreu), nenhuma conexão passa: 407', async () => {
    assert.match(await connectThrough(port, 'example.com:443'), /^HTTP\/1\.1 407/)
    const token = gate.register(() => ({ allowed: true, reason: 'tudo', pattern: '*' }))
    gate.release(token)
    assert.match(await connectThrough(port, 'example.com:443', token), /^HTTP\/1\.1 403/)
    assert.strictEqual((await gate.decide(token, 'example.com', 443)).allowed, false)
  })

  it('o destino que a regra do comando nega: 403, com o motivo', async () => {
    const token = gate.register((host) => ({ allowed: host === 'api.github.com', reason: `regra para ${host}`, pattern: 'api.github.com' }))
    assert.match(await connectThrough(port, 'evil.example:443', token), /^HTTP\/1\.1 403/)
    gate.release(token)
  })

  it('⛔ o próprio servidor, link-local e metadados da nuvem: negados mesmo com regra "*"', async () => {
    const token = gate.register(() => ({ allowed: true, reason: 'tudo', pattern: '*' }))
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal', '::1', '0.0.0.0']) {
      assert.strictEqual((await gate.decide(token, host, 80)).allowed, false, host)
    }
    gate.release(token)
  })

  it('⛔ IPv6 mapeado em hexa e ::1 expandido: o mesmo loopback e o mesmo metadado, negados com "*" (inclusive a porta do gateway)', async () => {
    const token = gate.register(() => ({ allowed: true, reason: 'tudo', pattern: '*' }))
    const gatewayPort = Number(process.env.PORT) || 3000
    for (const host of [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '0:0:0:0:0:0:0:1',
      '0:0:0:0:0:ffff:7f00:1',
      '::ffff:127.0.0.1',
      '::127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::1',
      'fe80::1',
    ]) {
      assert.strictEqual((await gate.decide(token, host, gatewayPort)).allowed, false, `${host}:${gatewayPort}`)
      assert.strictEqual((await gate.decide(token, host, 80)).allowed, false, `${host}:80`)
    }
    for (const host of ['::ffff:c0a8:101', '::ffff:a00:1']) assert.match((await gate.decide(token, host, 80)).reason, /rede local/, host)
    assert.match(await connectThrough(port, `[::ffff:7f00:1]:${gatewayPort}`, token), /^HTTP\/1\.1 403/)
    // loopback por IP literal em outra grafia só com a regra exata, como o `localhost`
    const exact = gate.register(() => ({ allowed: true, reason: 'o mongo', pattern: 'localhost:27017' }))
    assert.strictEqual((await gate.decide(exact, '::ffff:7f00:1', 27017)).address, '127.0.0.1')
    gate.release(token)
    gate.release(exact)
  })

  it('⛔ a porta do gateway vale também para o IP privado resolvido (a LAN da própria máquina)', async () => {
    const gatewayPort = Number(process.env.PORT) || 3000
    const token = gate.register(() => ({ allowed: true, reason: 'x', pattern: `10.0.0.5:${gatewayPort}` }))
    assert.match((await gate.decide(token, '10.0.0.5', gatewayPort)).reason, /do próprio gateway/)
    gate.release(token)
  })

  it('⛔ serviço local só com a regra EXATA localhost:<porta>; as portas do gateway, nunca', async () => {
    const exact = gate.register((host, port) => ({ allowed: host === 'localhost' && port === 27017, reason: 'o mongo', pattern: 'localhost:27017' }))
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      const verdict = await gate.decide(exact, host, 27017)
      assert.deepStrictEqual([verdict.allowed, verdict.address], [true, '127.0.0.1'], host)
    }
    assert.strictEqual((await gate.decide(exact, 'localhost', 6379)).allowed, false, 'outra porta')
    const wildcard = gate.register(() => ({ allowed: true, reason: 'tudo', pattern: 'localhost:*' }))
    assert.strictEqual((await gate.decide(wildcard, 'localhost', 27017)).allowed, false, 'curinga não abre o loopback')
    const gatewayPort = Number(process.env.PORT) || 3000
    const own = gate.register(() => ({ allowed: true, reason: 'x', pattern: `localhost:${gatewayPort}` }))
    assert.match((await gate.decide(own, 'localhost', gatewayPort)).reason, /do próprio gateway/)
    for (const token of [exact, wildcard, own]) gate.release(token)
  })

  it('rede local só com regra exata, nunca por curinga', async () => {
    const wildcard = gate.register(() => ({ allowed: true, reason: 'tudo', pattern: '*' }))
    const exact = gate.register(() => ({ allowed: true, reason: 'o servidor', pattern: '10.0.0.5:22' }))
    assert.strictEqual((await gate.decide(wildcard, '10.0.0.5', 22)).allowed, false)
    assert.strictEqual((await gate.decide(exact, '10.0.0.5', 22)).allowed, true)
    gate.release(wildcard)
    gate.release(exact)
  })

  it('⛔ um cliente que cai no meio (RST) não derruba o gateway', async () => {
    const token = gate.register(() => ({ allowed: false, reason: 'não' }))
    for (let i = 0; i < 5; i += 1) {
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(`CONNECT evil.example:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${token}:x`).toString('base64')}\r\n\r\n`)
          socket.resetAndDestroy()
          setTimeout(resolve, 30)
        })
        socket.on('error', () => undefined)
      })
    }
    assert.match(await connectThrough(port, 'evil.example:443', token), /^HTTP\/1\.1 403/)
    gate.release(token)
  })

  it('classifica o endereço resolvido', () => {
    assert.deepStrictEqual(['127.0.0.1', '::ffff:127.0.0.1', 'fe80::1', '192.168.1.10', '100.64.0.1', '8.8.8.8'].map(addressKind), [
      'blocked',
      'blocked',
      'blocked',
      'private',
      'private',
      'public',
    ])
  })

  it('⚖️ o túnel liga no IPv4 antes do IPv6 (o host sem rota IPv6 perdia a conexão); só IPv6, o IPv6', () => {
    assert.strictEqual(
      preferredAddress([
        { address: '2606:4700:3037::6815:5150', family: 6 },
        { address: '104.21.81.80', family: 4 },
      ]),
      '104.21.81.80',
    )
    assert.strictEqual(preferredAddress([{ address: '2606:4700::1', family: 6 }]), '2606:4700::1')
    assert.throws(() => preferredAddress([]))
  })
})
