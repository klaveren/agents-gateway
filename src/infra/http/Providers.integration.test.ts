import assert from 'node:assert'
import { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { makeAuthController, makeController, makeProvidersController } from '@composition/factories/Controller.Factory'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { probeKey } from '@infra/providers/Provider.Probe'
import { HttpServer } from './Http.Server'

const PASSWORD = 'frase longa o bastante'
const SECRET = 'sk-ant-chave-de-teste-que-nunca-volta-7777'

describe('Providers (integração)', () => {
  let base: string
  let stop: () => void
  let admin = ''
  let member = ''

  const call = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.token ? { 'X-Tool-Authorization': `Bearer ${init.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    return { status: res.status, text: await res.text() }
  }

  before(async () => {
    process.env.MCP_SERVER_URL = 'http://127.0.0.1:1/mcp'
    delete process.env.ANTHROPIC_API_KEY
    const server = new HttpServer(makeController(), makeAuthController(), makeProvidersController()).start(0)
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    server.unref()
    stop = () => {
      server.closeAllConnections()
      server.close()
    }

    admin = JSON.parse((await call('/auth/setup', { method: 'POST', body: { email: 'root@x.test', name: 'Root', password: PASSWORD } })).text).result.token
    await call('/users', { method: 'POST', token: admin, body: { email: 'ana@x.test', name: 'Ana', password: PASSWORD } })
    member = JSON.parse((await call('/auth/login', { method: 'POST', body: { email: 'ana@x.test', password: PASSWORD } })).text).result.token
  })

  after(() => stop())

  it('⛔ membro recebe 404 em tudo', async () => {
    assert.strictEqual((await call('/providers', { token: member })).status, 404)
    assert.strictEqual((await call('/providers/claude/key', { method: 'PUT', token: member, body: { key: SECRET } })).status, 404)
  })

  it('salvar: a origem vira "stored", com o final — e a chave nunca aparece em resposta nenhuma', async () => {
    const saved = await call('/providers/claude/key', { method: 'PUT', token: admin, body: { key: SECRET } })
    const listed = await call('/providers', { token: admin })

    assert.strictEqual(saved.status, 200)
    assert.ok(!saved.text.includes(SECRET) && !listed.text.includes(SECRET))
    const claude = JSON.parse(listed.text).result.find((item: { provider: string }) => item.provider === 'claude')
    assert.deepStrictEqual([claude.source, claude.last4, claude.updatedBy], ['stored', '7777', 'root@x.test'])
    assert.ok(claude.models.includes('claude-sonnet-5'))
  })

  it('remover volta a "none" (sem chave no ambiente)', async () => {
    const removed = JSON.parse((await call('/providers/claude/key', { method: 'DELETE', token: admin })).text).result
    assert.strictEqual(removed.source, 'none')
  })

  it('provider desconhecido é 404; chave com espaço é 422', async () => {
    assert.strictEqual((await call('/providers/llama/key', { method: 'PUT', token: admin, body: { key: SECRET } })).status, 404)
    assert.strictEqual((await call('/providers/claude/key', { method: 'PUT', token: admin, body: { key: 'tem espaco aqui' } })).status, 422)
  })
})

describe('probeKey', () => {
  it('ok com a contagem de modelos; erro do fornecedor com a chave mascarada', async () => {
    const ok = await probeKey(EProvider.OPENAI, SECRET, (async () => new Response(JSON.stringify({ data: [{}, {}, {}] }), { status: 200 })) as typeof fetch)
    assert.deepStrictEqual(ok, { ok: true, models: 3 })

    const failed = await probeKey(
      EProvider.CLAUDE,
      SECRET,
      (async () => new Response(JSON.stringify({ error: { message: `invalid x-api-key ${SECRET}` } }), { status: 401 })) as typeof fetch,
    )
    assert.strictEqual(failed.ok, false)
    assert.strictEqual(failed.status, 401)
    assert.ok(!failed.message?.includes(SECRET))
    assert.ok(failed.message?.includes('…7777'))
  })

  it('a chave vai em cabeçalho, nunca na URL', async () => {
    const urls: string[] = []
    await probeKey(EProvider.GOOGLE, SECRET, (async (url: string) => (urls.push(url), new Response('{}', { status: 200 }))) as unknown as typeof fetch)
    assert.ok(!urls[0].includes(SECRET))
  })
})
