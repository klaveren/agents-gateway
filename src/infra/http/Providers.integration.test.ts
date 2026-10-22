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
    const claude = JSON.parse(listed.text).result.find((item: { id: string }) => item.id === 'claude')
    assert.deepStrictEqual([claude.credential.source, claude.credential.last4, claude.credential.updatedBy], ['stored', '7777', 'root@x.test'])
    assert.ok(claude.models.includes('claude-sonnet-5'))
  })

  it('remover volta a "none" (sem chave no ambiente)', async () => {
    const removed = JSON.parse((await call('/providers/claude/key', { method: 'DELETE', token: admin })).text).result
    assert.strictEqual(removed.credential.source, 'none')
  })

  it('cria um compatível (OpenRouter) já com a chave; a URL perde a barra final; a chave não volta', async () => {
    const created = await call('/providers', {
      method: 'POST',
      token: admin,
      body: { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1/', key: 'sk-or-v1-segredo-4321' },
    })
    const body = JSON.parse(created.text).result

    assert.strictEqual(created.status, 201)
    assert.deepStrictEqual(
      [body.protocol, body.baseUrl, body.official, body.credential.source, body.credential.last4],
      ['openai', 'https://openrouter.ai/api/v1', false, 'stored', '4321'],
    )
    assert.ok(!created.text.includes('segredo'))
  })

  it('um agente aponta para o compatível, com ids de modelo do provider; com agente usando, o provider não se apaga (409)', async () => {
    const agent = { id: 'roteado', name: 'Roteado', provider: 'openrouter', systemPrompt: 'Responda curto.', models: ['meta-llama/llama-4-maverick'], modes: ['chat'], allowedTools: [] }
    assert.strictEqual((await call('/agents', { method: 'POST', token: admin, body: agent })).status, 201)
    assert.strictEqual((await call('/agents', { method: 'POST', token: admin, body: { ...agent, id: 'fantasma', provider: 'nao-existe' } })).status, 422)

    const blocked = await call('/providers/openrouter', { method: 'DELETE', token: admin })
    assert.strictEqual(blocked.status, 409)
    assert.ok(blocked.text.includes('Roteado'))
  })

  it('⛔ URL sem https, com credencial embutida ou protocolo google: 422', async () => {
    for (const body of [
      { id: 'x1', name: 'X', protocol: 'openai', baseUrl: 'http://example.com/v1' },
      { id: 'x2', name: 'X', protocol: 'openai', baseUrl: 'https://user:pass@example.com/v1' },
      { id: 'x3', name: 'X', protocol: 'google', baseUrl: 'https://example.com' },
    ]) {
      assert.strictEqual((await call('/providers', { method: 'POST', token: admin, body })).status, 422)
    }
    assert.strictEqual(
      (await call('/providers', { method: 'POST', token: admin, body: { id: 'local', name: 'vLLM', protocol: 'openai', baseUrl: 'http://localhost:8000/v1' } })).status,
      201,
    )
  })

  it('⛔ oficial não se apaga nem muda de URL; compatível se apaga', async () => {
    assert.strictEqual((await call('/providers/claude', { method: 'DELETE', token: admin })).status, 422)
    assert.strictEqual((await call('/providers/claude', { method: 'PUT', token: admin, body: { baseUrl: 'https://outro.example.com' } })).status, 422)
    assert.strictEqual((await call('/providers/local', { method: 'DELETE', token: admin })).status, 200)
    assert.strictEqual((await call('/providers/local/key', { method: 'PUT', token: admin, body: { key: SECRET } })).status, 404)
  })

  it('provider desconhecido é 404; chave com espaço é 422', async () => {
    assert.strictEqual((await call('/providers/llama/key', { method: 'PUT', token: admin, body: { key: SECRET } })).status, 404)
    assert.strictEqual((await call('/providers/claude/key', { method: 'PUT', token: admin, body: { key: 'tem espaco aqui' } })).status, 422)
  })
})

describe('probeKey', () => {
  it('ok com a contagem de modelos; erro do fornecedor com a chave mascarada', async () => {
    const ok = await probeKey({ protocol: EProvider.OPENAI }, SECRET, (async () => new Response(JSON.stringify({ data: [{}, {}, {}] }), { status: 200 })) as typeof fetch)
    assert.deepStrictEqual(ok, { ok: true, models: 3 })

    const failed = await probeKey(
      { protocol: EProvider.CLAUDE },
      SECRET,
      (async () => new Response(JSON.stringify({ error: { message: `invalid x-api-key ${SECRET}` } }), { status: 401 })) as typeof fetch,
    )
    assert.strictEqual(failed.ok, false)
    assert.strictEqual(failed.status, 401)
    assert.ok(!failed.message?.includes(SECRET))
    assert.ok(failed.message?.includes('…7777'))
  })

  it('⚠️ OpenRouter: a listagem é pública, então a chave é conferida no /key', async () => {
    const urls: string[] = []
    const fetcher = (async (url: string) => {
      urls.push(url)
      return url.endsWith('/key')
        ? new Response(JSON.stringify({ error: { message: 'No auth credentials found' } }), { status: 401 })
        : new Response(JSON.stringify({ data: [{}] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await probeKey({ protocol: EProvider.OPENAI, baseUrl: 'https://openrouter.ai/api/v1' }, 'sk-or-inventada', fetcher)

    assert.deepStrictEqual(urls, ['https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/key'])
    assert.deepStrictEqual([result.ok, result.status], [false, 401])
  })

  it('a chave vai em cabeçalho, nunca na URL', async () => {
    const urls: string[] = []
    await probeKey({ protocol: EProvider.GOOGLE }, SECRET, (async (url: string) => (urls.push(url), new Response('{}', { status: 200 }))) as unknown as typeof fetch)
    assert.ok(!urls[0].includes(SECRET))
  })
})
