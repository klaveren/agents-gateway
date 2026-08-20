import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeController } from '@composition/factories/Controller.Factory'
import { HttpServer } from './Http.Server'

/**
 * O único teste que sobe o Express de verdade.
 *
 * Tudo o mais testa peça isolada, então o que só existe montado — ordem de middleware,
 * parser de corpo, CORS, token, o handler de erro no fim da cadeia — não era exercitado por
 * ninguém. É justamente onde mora o tipo de defeito que passa em toda unidade e quebra em
 * produção.
 */
describe('HttpServer (integração)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    // O health tenta reconectar o MCP. Apontar para uma porta que recusa na hora mantém o
    // teste offline e rápido, em vez de esperar timeout de socket.
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    // Porta 0 = o SO escolhe uma livre, então o teste não briga com o gateway rodando.
    const server = new HttpServer(makeController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))

    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}/v1`
    // `fetch` deixa socket em keep-alive: sem derrubar as conexões o close() nunca completa.
    // E nada de esperar o callback — o node:test encerra quando o loop drena.
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => stop())

  it('responde o health com o envelope da API', async () => {
    const res = await fetch(`${base}/health`)
    const body = await res.json()

    assert.strictEqual(res.status, 200)
    assert.strictEqual(body.ok, true)
    assert.strictEqual(body.result.status, 'ok')
  })

  it('serve o contrato em openapi.json', async () => {
    const res = await fetch(`${base}/openapi.json`)
    const body = await res.json()

    assert.strictEqual(res.status, 200)
    assert.strictEqual(body.openapi, '3.1.0')
  })

  it('recusa corpo inválido com 422 e código legível', async () => {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const body = await res.json()

    assert.strictEqual(res.status, 422)
    assert.strictEqual(body.code, 'validation_error')
    assert.deepStrictEqual(body.details, [{ field: 'agentId', message: 'agentId is required' }])
  })

  it('404 com código quando o agente não existe', async () => {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'fantasma' }),
    })

    assert.strictEqual(res.status, 404)
    assert.strictEqual((await res.json()).code, 'agent_not_found')
  })

  it('JSON malformado não escapa cru pelo handler de erro', async () => {
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ isso não é json',
    })
    const body = await res.json()

    // Sem o handler no fim da cadeia, o express devolveria HTML de stack trace.
    assert.ok(res.status >= 400)
    assert.strictEqual(body.ok, false)
    assert.ok(typeof body.code === 'string')
  })

  it('não emite Access-Control-Allow-Origin para origem estranha', async () => {
    const res = await fetch(`${base}/agents`, { headers: { Origin: 'https://evil.example' } })

    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null)
  })

  it('rota desconhecida é 404', async () => {
    assert.strictEqual((await fetch(`${base}/naoexiste`)).status, 404)
  })
})

describe('HttpServer com GATEWAY_TOKEN', () => {
  let base: string
  let stop: () => void

  before(async () => {
    process.env.GATEWAY_TOKEN = 's3cret'
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const server = new HttpServer(makeController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))

    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}/v1`
    // `fetch` deixa socket em keep-alive: sem derrubar as conexões o close() nunca completa.
    // E nada de esperar o callback — o node:test encerra quando o loop drena.
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => {
    delete process.env.GATEWAY_TOKEN
    stop()
  })

  it('barra sem token e passa com o token certo', async () => {
    const semToken = await fetch(`${base}/agents`)
    assert.strictEqual(semToken.status, 401)
    assert.strictEqual((await semToken.json()).code, 'unauthorized')

    const errado = await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer nope' } })
    assert.strictEqual(errado.status, 401)

    const certo = await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer s3cret' } })
    assert.strictEqual(certo.status, 200)
  })
})
