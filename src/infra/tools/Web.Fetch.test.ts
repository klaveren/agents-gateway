import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IPermissionChecker } from '@application/Permissions.Service'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { fetchUrlTool, htmlText } from './Web.Fetch'

describe('fetch_url (Abrir página do gateway)', () => {
  let server: Server
  let port: number
  const context = { sessionId: 'gw_1', agentId: 'assistente' } as IExecutionContext

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page')
        return res
          .writeHead(200, { 'content-type': 'text/html' })
          .end('<html><head><title>Oi</title><script>x()</script></head><body><h1>Título</h1><p>Um <a href="https://ex.com">link</a></p></body></html>')
      if (req.url === '/away') return res.writeHead(302, { location: 'http://169.254.169.254/latest' }).end()
      if (req.url === '/bin') return res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF')
      res.writeHead(404).end('nope')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })
  after(() => server.close())

  /** A regra de rede: libera exatamente `localhost:<porta>` (serviço local só passa com regra exata). */
  const rules = (allowed: boolean): IPermissionChecker => ({
    check: () => ({
      allowed,
      layer: 'agent',
      reason: allowed ? 'regra' : 'sem regra de rede',
      ...(allowed ? { rule: { category: 'network', pattern: `localhost:${port}`, decision: 'allow' } as never } : {}),
    }),
  })
  const get = (path: string, allowed = true) => fetchUrlTool(rules(allowed)).execute({ url: `http://localhost:${port}${path}` }, context)

  it('devolve o texto da página, sem script, com o título e o endereço dos links', async () => {
    const result = await get('/page')
    assert.equal(result.status, 'success', String(result.result))
    assert.match(String(result.result), /Title: Oi/)
    assert.match(String(result.result), /# Título/)
    assert.match(String(result.result), /link \(https:\/\/ex\.com\)/)
    assert.doesNotMatch(String(result.result), /x\(\)/)
  })

  it('⛔ sem a regra de rede, recusa; o redirecionamento para os metadados também', async () => {
    assert.match(String((await get('/page', false)).result), /Not permitted: sem regra de rede/)
    assert.match(String((await get('/away')).result), /Not permitted/)
  })

  it('⛔ sem regra, só a internet: localhost e rede local ficam de fora', async () => {
    const result = await fetchUrlTool().execute({ url: `http://localhost:${port}/page` }, context)
    assert.match(String(result.result), /Not permitted/)
  })

  it('binário não vira texto', async () => {
    assert.match(String((await get('/bin')).result), /application\/pdf, not a text page/)
  })

  it('htmlText junta blocos em linhas', () => {
    assert.equal(htmlText('<body><p>a</p><p>b</p></body>'), 'a\nb')
  })
})
