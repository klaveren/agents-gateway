import assert from 'node:assert'
import { createServer, request, Agent } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { applyServerTimeouts, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, serverTimeouts } from './Server.Timeouts'

describe('serverTimeouts', () => {
  it('keep-alive de 65 s por padrão, cabeçalhos logo acima', () => {
    const timeouts = serverTimeouts({})
    assert.strictEqual(timeouts.keepAliveTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
    assert.ok(timeouts.headersTimeout > timeouts.keepAliveTimeout)
  })

  it('env ajusta; valor inválido volta ao padrão; cabeçalhos nunca abaixo do keep-alive', () => {
    assert.deepStrictEqual(serverTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: '120000', HTTP_HEADERS_TIMEOUT_MS: '200000' }), {
      keepAliveTimeout: 120_000,
      headersTimeout: 200_000,
    })
    assert.strictEqual(serverTimeouts({ HTTP_KEEP_ALIVE_TIMEOUT_MS: 'abc' }).keepAliveTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
    assert.strictEqual(serverTimeouts({ HTTP_HEADERS_TIMEOUT_MS: '10' }).headersTimeout, DEFAULT_KEEP_ALIVE_TIMEOUT_MS + 1_000)
  })
})

describe('applyServerTimeouts', () => {
  it('conexão reaproveitada depois de 5 s ociosa ainda atende (o padrão do Node a teria fechado)', async (t) => {
    const server = applyServerTimeouts(
      createServer((_req, res) => res.end('ok')),
      { HTTP_KEEP_ALIVE_TIMEOUT_MS: '65000' },
    )
    assert.strictEqual(server.keepAliveTimeout, 65_000)
    assert.strictEqual(server.timeout, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    t.after(() => agent.destroy())
    const port = (server.address() as AddressInfo).port
    const sockets = new Set<unknown>()
    const get = () =>
      new Promise<string>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, agent, path: '/' }, (res) => {
          sockets.add(res.socket)
          let body = ''
          res.on('data', (chunk) => (body += chunk))
          res.on('end', () => resolve(body))
        })
        req.on('error', reject)
        req.end()
      })
    assert.strictEqual(await get(), 'ok')
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    assert.strictEqual(await get(), 'ok')
    assert.strictEqual(sockets.size, 1, 'a segunda chamada usou a mesma conexão')
  })
})
