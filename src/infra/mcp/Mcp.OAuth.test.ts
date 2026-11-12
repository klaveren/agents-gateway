import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IMcpServerConfig, mcpOAuthTokenKey } from '@domain/models/McpServer.Model'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { withCaller } from './Caller.Identity'
import { McpOAuth } from './Mcp.OAuth'
import { McpRegistry } from './Mcp.Registry'
import { McpServerClient } from './McpServer.Client'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'

const AS = 'https://login.exemplo.test'
const server: IMcpServerConfig = {
  id: 'gmail',
  name: 'Gmail',
  url: 'https://mcp.exemplo.test/mcp',
  transport: 'auto',
  auth: 'oauth',
  oauth: { clientId: 'cliente-1', scopes: 'mail.read', authorizationServer: AS },
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

/** O cofre em memória (o de verdade cifra; aqui importa o que entra e sai). */
function vault(): ICredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>([['mcp:gmail', 'segredo-do-cliente']])
  return {
    values,
    get: (id) => values.get(id),
    save: (id, key) => void values.set(id, key),
    clear: (id) => void values.delete(id),
    status: () => [],
    subscribe: () => undefined,
  }
}

/** O provedor falso: publica os metadados e troca código e token de renovação, contando as trocas. */
function provider() {
  const posts: URLSearchParams[] = []
  let issued = 0
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/.well-known/oauth-authorization-server'))
      return Response.json({
        issuer: AS,
        authorization_endpoint: `${AS}/authorize`,
        token_endpoint: `${AS}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      })
    if (url === `${AS}/token`) {
      const body = new URLSearchParams(String(init?.body))
      posts.push(body)
      issued++
      return Response.json({ access_token: `token-${issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `renova-${issued}` })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchFn, posts }
}

describe('McpOAuth', () => {
  it('⛔ sem `fetchFn` injetado (produção), a descoberta e a troca passam pela política de saída: metadado da nuvem nunca', async () => {
    const original = globalThis.fetch
    const reached: string[] = []
    globalThis.fetch = (async (input: unknown) => {
      reached.push(String(input instanceof Request ? input.url : input))
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    try {
      const hostile = { ...server, url: 'http://169.254.169.254/mcp', oauth: { clientId: 'c', authorizationServer: 'http://169.254.169.254' } }
      const oauth = new McpOAuth({ get: () => hostile }, vault())
      await oauth.start('gmail', 'ana', 'https://gw.test/v1/oauth/callback').catch(() => undefined)
      assert.deepStrictEqual(reached, [])
    } finally {
      globalThis.fetch = original
    }
  })

  it('começa com PKCE e state, troca o código pelo token da pessoa (com o client secret), e o state não serve duas vezes', async () => {
    const credentials = vault()
    const { fetchFn, posts } = provider()
    const oauth = new McpOAuth({ get: () => server }, credentials, Date.now, fetchFn)
    const url = new URL(await oauth.start('gmail', 'ana', 'https://gw.test/v1/oauth/callback'))
    assert.strictEqual(url.origin + url.pathname, `${AS}/authorize`)
    assert.strictEqual(url.searchParams.get('client_id'), 'cliente-1')
    assert.strictEqual(url.searchParams.get('scope'), 'mail.read')
    assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256')
    const state = url.searchParams.get('state')!

    await assert.rejects(() => oauth.finish('outro-state', 'codigo'), /expired or was already used/)
    assert.deepStrictEqual(await oauth.finish(state, 'codigo'), { serverKey: 'gmail' })
    assert.strictEqual(posts[0].get('code'), 'codigo')
    assert.strictEqual(posts[0].get('client_secret'), 'segredo-do-cliente')
    assert.ok(posts[0].get('code_verifier'))
    assert.strictEqual(await oauth.accessToken('gmail', 'ana'), 'token-1')
    assert.strictEqual(oauth.connected('gmail', 'bia'), false)
    await assert.rejects(() => oauth.finish(state, 'codigo'), /expired or was already used/)
  })

  it('renova o token perto de vencer (uma vez só, mesmo com chamadas juntas) e desconectar apaga', async () => {
    const credentials = vault()
    const { fetchFn, posts } = provider()
    let now = 1_000_000
    const oauth = new McpOAuth({ get: () => server }, credentials, () => now, fetchFn)
    credentials.save(mcpOAuthTokenKey('gmail', 'ana'), JSON.stringify({ accessToken: 'velho', refreshToken: 'renova-0', expiresAt: now + 30_000 }), 'ana')
    const [first, second] = await Promise.all([oauth.accessToken('gmail', 'ana'), oauth.accessToken('gmail', 'ana')])
    assert.deepStrictEqual([first, second], ['token-1', 'token-1'])
    assert.strictEqual(posts.length, 1)
    assert.strictEqual(posts[0].get('refresh_token'), 'renova-0')
    now += 10_000
    assert.strictEqual(await oauth.accessToken('gmail', 'ana'), 'token-1')
    oauth.disconnect('gmail', 'ana')
    assert.strictEqual(await oauth.accessToken('gmail', 'ana'), undefined)
  })
})

describe('McpRegistry — OAuth: um cliente por pessoa', () => {
  it('sem pessoa, nenhum cliente; cada pessoa tem o seu, com o token dela no Authorization', async () => {
    const repository = new SqliteMcpServerRepository()
    repository.insert(server)
    const made: Array<{ bearer?: () => Promise<string | undefined> }> = []
    const registry = new McpRegistry(repository, { get: () => undefined }, (config, options) => {
      made.push(options)
      return new McpServerClient(config.url, {}, options)
    })
    registry.useOAuth({ accessToken: async (_key, userId) => `token-de-${userId}` })
    assert.strictEqual(registry.client('gmail'), undefined)
    const ana = withCaller({ id: 'ana' }, () => registry.client('gmail'))
    const bia = withCaller({ id: 'bia' }, () => registry.client('gmail'))
    assert.ok(ana && bia && ana !== bia)
    assert.strictEqual(
      withCaller({ id: 'ana' }, () => registry.client('gmail')),
      ana,
    )
    assert.deepStrictEqual(await Promise.all(made.map((options) => options.bearer?.())), ['token-de-ana', 'token-de-bia'])
    registry.forget('gmail', 'ana')
    assert.notStrictEqual(
      withCaller({ id: 'ana' }, () => registry.client('gmail')),
      ana,
    )
  })
})

describe('McpServerClient — `auth: oauth`', () => {
  it('manda o token da pessoa, lido a cada requisição; sem token, nenhum Authorization', async () => {
    const seen: Array<string | null> = []
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      return new Response('nope', { status: 500 })
    }) as typeof fetch
    let token: string | undefined = 'token-a'
    await new McpServerClient('https://mcp.exemplo.test/mcp', { fetch: fakeFetch }, { auth: 'oauth', bearer: async () => token }).connect()
    assert.ok(seen.length && seen.every((value) => value === 'Bearer token-a'))
    seen.length = 0
    token = undefined
    await new McpServerClient('https://mcp.exemplo.test/mcp', { fetch: fakeFetch }, { auth: 'oauth', bearer: async () => token }).connect()
    assert.ok(seen.length && seen.every((value) => value === null))
  })
})
