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
/** JWT sem assinatura válida: o gateway só lê o payload, e quem confere é a prova. */
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('HttpServer (integração)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    // O corpo destes casos é da API, não do portão do chamador: `ALLOW_ANONYMOUS=1` abre só o portão.
    // O portão em si é exercitado nas suítes abaixo.
    process.env.ALLOW_ANONYMOUS = '1'
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

  after(() => {
    delete process.env.ALLOW_ANONYMOUS
    stop()
  })

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
      body: JSON.stringify({ mode: 'nope' }),
    })
    const body = await res.json()

    assert.strictEqual(res.status, 422)
    assert.strictEqual(body.code, 'validation_error')
    assert.deepStrictEqual(body.details, [{ field: 'mode', message: 'Invalid option: expected one of "chat"|"agent"' }])
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

describe('HttpServer fechado por padrão (sem ALLOW_ANONYMOUS)', () => {
  let base: string
  let stop: () => void

  before(async () => {
    delete process.env.ALLOW_ANONYMOUS
    delete process.env.CALLER_PROOF_TOOL
    delete process.env.REQUIRE_PROVEN_OWNER
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    const server = new HttpServer(makeController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))

    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }
  })

  after(() => {
    delete process.env.REQUIRE_PROVEN_OWNER
    stop()
  })

  it('⛔ o `Authorization` não é credencial: sem `X-Tool-Authorization` continua 401, mesmo com GATEWAY_TOKEN no ambiente', async () => {
    process.env.GATEWAY_TOKEN = 's3cret'
    try {
      const res = await fetch(`${base}/agents`, { headers: { Authorization: 'Bearer s3cret' } })
      assert.strictEqual(res.status, 401)
      assert.strictEqual((await res.json()).code, 'unauthorized')
    } finally {
      delete process.env.GATEWAY_TOKEN
    }
  })

  it('o health é público: não pede credencial nenhuma', async () => {
    assert.strictEqual((await fetch(`${base}/health`)).status, 200)
  })

  it('/shared/:id também é pública: sem credencial responde 404 do link, não 401', async () => {
    const res = await fetch(`${base}/shared/qualquer`)

    assert.strictEqual(res.status, 404)
    assert.strictEqual((await res.json()).code, 'not_found')
  })

  it('as rotas de conversa pedem credencial, inclusive a de estatística e a de apagar', async () => {
    for (const [path, init] of [
      ['/conversations'],
      ['/conversations/stats'],
      ['/conversations/x/turns'],
      ['/conversations/x/share', { method: 'PUT' }],
      ['/conversations/x', { method: 'DELETE' }],
    ] as Array<[string, RequestInit?]>) {
      assert.strictEqual((await fetch(`${base}${path}`, init)).status, 401, path)
    }
  })

  it('toda outra rota responde 401 sem a credencial do chamador', async () => {
    const calls: Array<[string, RequestInit?]> = [
      ['/agents'],
      ['/agents/pesquisa-teste/tools'],
      ['/tools'],
      ['/openapi.json'],
      ['/sessions'],
      ['/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
      ['/sessions/qualquer'],
      ['/sessions/qualquer', { method: 'DELETE' }],
      ['/sessions/qualquer/cancel', { method: 'POST' }],
      ['/sessions/qualquer/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"oi"}' }],
    ]

    for (const [path, init] of calls) {
      const res = await fetch(`${base}${path}`, init)
      assert.strictEqual(res.status, 401, `${init?.method ?? 'GET'} ${path}`)
      assert.strictEqual((await res.json()).code, 'unauthorized')
    }
  })

  it('header vazio ou só "Bearer" não é credencial', async () => {
    for (const value of ['', 'Bearer ', '   ']) {
      const res = await fetch(`${base}/agents`, { headers: { 'X-Tool-Authorization': value } })
      assert.strictEqual(res.status, 401, JSON.stringify(value))
    }
  })

  it('credencial sem prova configurada é recusada nas rotas de identidade', async () => {
    // Prova desligada + padrão seguro: o token só AFIRMA quem é, e isso não abre nada.
    for (const path of ['/agents', '/tools', '/openapi.json', '/sessions']) {
      const res = await fetch(`${base}${path}`, { headers: { 'X-Tool-Authorization': `Bearer ${jwt({ sub: 'u1' })}` } })
      assert.strictEqual(res.status, 401, path)
    }
  })

  it('com REQUIRE_PROVEN_OWNER=0 a identidade afirmada passa, e a persona não sai em /agents', async () => {
    process.env.REQUIRE_PROVEN_OWNER = '0'
    const headers = { 'X-Tool-Authorization': `Bearer ${jwt({ sub: 'u1' })}` }

    const agents = await fetch(`${base}/agents`, { headers })
    assert.strictEqual(agents.status, 200)
    const list = (await agents.json()).result as Array<Record<string, unknown>>
    // ⛔ Quem não administra só vê agente ATIVO — e aqui nenhum provider tem chave nem modelo ativado.
    assert.deepStrictEqual(list, [])
    assert.ok(list.every((agent) => !('systemPrompt' in agent)))

    assert.strictEqual((await fetch(`${base}/openapi.json`, { headers })).status, 200)

    // Credencial que não identifica ninguém nunca cai no escopo "sem dono".
    const sem = await fetch(`${base}/sessions`, { headers: { 'X-Tool-Authorization': `Bearer ${jwt({})}` } })
    assert.strictEqual(sem.status, 401)
  })
})
