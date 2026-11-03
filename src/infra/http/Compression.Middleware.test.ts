import assert from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import express from 'express'
import { compressJson, gzipStatic } from './Compression.Middleware'

describe('Compression.Middleware — JSON da API e arquivos da tela em gzip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-gzip-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'index-abc.js'), 'console.log(1);\n'.repeat(500))
  writeFileSync(join(dir, 'favicon.svg'), '<svg/>'.repeat(400))
  const app = express()
  app.use(compressJson())
  app.get('/v1/big', (_req, res) => void res.json({ items: Array.from({ length: 500 }, (_, index) => ({ index, text: 'abc' })) }))
  app.get('/v1/small', (_req, res) => void res.status(201).json({ ok: true }))
  app.get('/v1/stream', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: 1\n\n')
    res.end()
  })
  app.use(gzipStatic(dir))
  app.use(express.static(dir))
  const server = app.listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  // O `fetch` descomprime sozinho: o cabeçalho diz se veio comprimido, e o `raw` confere o corpo.
  const get = (path: string, gzip = true) => fetch(`${base}${path}`, { headers: gzip ? { 'Accept-Encoding': 'gzip' } : { 'Accept-Encoding': 'identity' } })

  it('JSON grande vai comprimido (e volta igual); pequeno, sem gzip no pedido ou fluxo ao vivo, não', async () => {
    const big = await get('/v1/big')
    assert.strictEqual(big.headers.get('content-encoding'), 'gzip')
    assert.strictEqual(((await big.json()) as { items: unknown[] }).items.length, 500)
    const small = await get('/v1/small')
    assert.deepStrictEqual([small.status, small.headers.get('content-encoding'), await small.json()], [201, null, { ok: true }])
    assert.strictEqual((await get('/v1/big', false)).headers.get('content-encoding'), null)
    const stream = await get('/v1/stream')
    assert.deepStrictEqual([stream.headers.get('content-encoding'), await stream.text()], [null, 'data: 1\n\n'])
  })

  it('arquivo da tela comprimido; o com hash (/assets/) com cache de um ano; fora da pasta ou inexistente segue adiante', async () => {
    const js = await get('/assets/index-abc.js')
    assert.deepStrictEqual([js.status, js.headers.get('content-encoding'), js.headers.get('cache-control')], [200, 'gzip', 'public, max-age=31536000, immutable'])
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
    assert.strictEqual((await js.text()).length, 'console.log(1);\n'.length * 500)
    const svg = await get('/favicon.svg')
    assert.deepStrictEqual([svg.headers.get('content-encoding'), svg.headers.get('cache-control')], ['gzip', 'public, max-age=0'])
    assert.strictEqual((await get('/assets/nada.js')).status, 404)
    assert.strictEqual((await get('/assets/index-abc.js', false)).headers.get('content-encoding'), null)
    assert.notStrictEqual((await get('/%2e%2e/%2e%2e/etc/passwd.js')).status, 200)
  })
})
