import assert from 'node:assert'
import { createServer, Server } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { egressPolicy, guardedFetch, hostListed, listFromEnv } from './Guarded.Fetch'

describe('Guarded.Fetch', () => {
  let server: Server
  let port = 0
  const seen: Array<{ url: string; auth?: string }> = []
  before(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/redirect-self') return void res.writeHead(302, { location: '/ok' }).end()
      if (req.url === '/redirect-metadata') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end()
      if (req.url === '/redirect-localhost') return void res.writeHead(302, { location: `http://localhost:${port}/ok` }).end()
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  after(() => server.close())

  const strict = () => guardedFetch(egressPolicy({ allowPrivate: false, listed: () => false }))
  const listedLoopback = () => guardedFetch(egressPolicy({ allowPrivate: false, listed: (url, address) => hostListed(['127.0.0.1/8', 'localhost'], url, address) }))

  it('⛔ loopback e rede interna, por IP ou por nome que resolve para eles: recusados antes de conectar', async () => {
    const before = seen.length
    for (const url of [
      `http://127.0.0.1:${port}/ok`,
      `http://[::ffff:7f00:1]:${port}/ok`,
      `http://localhost:${port}/ok`,
      'http://[::ffff:a9fe:a9fe]/',
      'http://169.254.169.254/',
      'http://10.0.0.1/',
    ])
      await assert.rejects(() => strict()(url), /loopback|link-local|rede local|ECONN|fetch|resolveu/i, url)
    assert.strictEqual(seen.length, before, 'nada chegou ao servidor')
  })

  it('⛔ o metadado da nuvem nunca passa, nem com o host listado nem com allowPrivate', async () => {
    const open = guardedFetch(egressPolicy({ allowPrivate: true, listed: () => true }))
    await assert.rejects(() => open('http://169.254.169.254/latest'), /link-local/)
    await assert.rejects(() => open('http://[::ffff:a9fe:a9fe]/latest'), /link-local/)
  })

  it('o host listado (ou o admin do gateway, allowPrivate) conecta no loopback', async () => {
    assert.strictEqual(await (await listedLoopback()(`http://127.0.0.1:${port}/ok`)).text(), 'ok')
    assert.strictEqual(await (await listedLoopback()(`http://localhost:${port}/ok`)).text(), 'ok')
    const admin = guardedFetch(egressPolicy({ allowPrivate: true, listed: () => false }))
    assert.strictEqual((await admin(`http://127.0.0.1:${port}/ok`, { method: 'POST', body: '{}' })).status, 200)
  })

  it('⛔ redirect para o metadado ou para um nome que resolve ao loopback: cada salto é conferido', async () => {
    const onlyIp = guardedFetch(egressPolicy({ allowPrivate: false, listed: (url, address) => address === '127.0.0.1' && url.hostname === '127.0.0.1' }))
    assert.strictEqual(await (await onlyIp(`http://127.0.0.1:${port}/redirect-self`)).text(), 'ok', 'redirect legítimo na mesma origem')
    await assert.rejects(() => onlyIp(`http://127.0.0.1:${port}/redirect-metadata`), /link-local/)
    await assert.rejects(() => onlyIp(`http://127.0.0.1:${port}/redirect-localhost`), /loopback/)
  })

  it('redirect: error recusa o salto; manual devolve o 3xx; salto para outra origem leva a credencial junto? nunca', async () => {
    await assert.rejects(() => listedLoopback()(`http://127.0.0.1:${port}/redirect-self`, { redirect: 'error' }), /redirecionamento/)
    assert.strictEqual((await listedLoopback()(`http://127.0.0.1:${port}/redirect-self`, { redirect: 'manual' })).status, 302)
  })

  it('a credencial fica na mesma origem e sai do salto para outra', async () => {
    const listed = guardedFetch(egressPolicy({ allowPrivate: true, listed: () => false }))
    seen.length = 0
    await listed(`http://127.0.0.1:${port}/redirect-self`, { headers: { Authorization: 'Bearer x' } })
    assert.deepStrictEqual(
      seen.map((entry) => entry.auth),
      ['Bearer x', 'Bearer x'],
    )
    seen.length = 0
    await listed(`http://127.0.0.1:${port}/redirect-localhost`, { headers: { Authorization: 'Bearer x' } })
    assert.deepStrictEqual(
      seen.map((entry) => entry.auth),
      ['Bearer x', undefined],
    )
  })

  it('a lista: host, host:porta, IP e faixa CIDR', () => {
    const url = new URL('http://10.20.1.5:4003/x')
    assert.ok(hostListed(['10.20.0.0/16'], url, '10.20.1.5'))
    assert.ok(hostListed(['10.20.1.5:4003'], url, '10.20.1.5'))
    assert.ok(!hostListed(['10.20.1.5:4004'], url, '10.20.1.5'))
    assert.ok(!hostListed(['10.30.0.0/16'], url, '10.20.1.5'))
    assert.deepStrictEqual(listFromEnv(' A.com, ,10.0.0.0/8 '), ['a.com', '10.0.0.0/8'])
  })
})
