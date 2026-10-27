import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { McpRegistry } from './Mcp.Registry'
import { McpServerClient } from './McpServer.Client'

const server = (over: Partial<IMcpServerConfig> = {}): IMcpServerConfig => ({
  id: 'crm',
  name: 'CRM',
  url: 'http://127.0.0.1:1/mcp',
  transport: 'auto',
  auth: 'caller',
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

describe('McpServerClient — credencial por servidor', () => {
  /** O `fetch` falso só registra os headers: a conexão falha, mas o que importa é o que foi enviado. */
  const capture = async (options: ConstructorParameters<typeof McpServerClient>[2], run?: (client: McpServerClient) => Promise<unknown>) => {
    const seen: Headers[] = []
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('nope', { status: 500 })
    }) as typeof fetch
    const client = new McpServerClient('http://127.0.0.1:1/mcp', { fetch: fakeFetch }, options)
    await (run ? run(client) : client.connect())
    return seen
  }

  it('`header` manda o segredo, lido na hora; `none` não manda nada', async () => {
    let value = 'Bearer um'
    const withHeader = await capture({ auth: 'header', header: () => ({ name: 'X-Api-Key', value }) })
    assert.ok(withHeader.length > 0)
    assert.ok(withHeader.every((headers) => headers.get('x-api-key') === 'Bearer um'))

    value = 'Bearer dois'
    const again = await capture({ auth: 'header', header: () => ({ name: 'X-Api-Key', value }) })
    assert.strictEqual(again[0].get('x-api-key'), 'Bearer dois')

    const none = await capture({ auth: 'none' })
    assert.ok(none.every((headers) => !headers.get('authorization') && !headers.get('x-api-key')))
  })

  it('`transport: http` não cai para SSE', async () => {
    const http = await capture({ auth: 'none', transport: 'http' })
    const auto = await capture({ auth: 'none', transport: 'auto' })
    assert.ok(auto.length > http.length)
  })

  it('guarda o último erro de conexão para a tela', async () => {
    let client: McpServerClient | undefined
    await capture({ auth: 'none' }, async (created) => {
      client = created
      await created.connect()
    })
    assert.ok(client?.lastError)
  })
})

describe('McpRegistry', () => {
  it('recria o cliente quando a configuração muda; desligado não tem cliente', () => {
    const repository = new SqliteMcpServerRepository(':memory:')
    repository.insert(server())
    const made: string[] = []
    const registry = new McpRegistry(repository, { get: () => undefined }, (config) => {
      made.push(config.url)
      return { close: async () => undefined, isConnected: () => false } as unknown as McpServerClient
    })

    const first = registry.client('crm')
    assert.strictEqual(registry.client('crm'), first)
    repository.update('crm', { url: 'http://127.0.0.1:2/mcp' })
    assert.notStrictEqual(registry.client('crm'), first)
    repository.update('crm', { enabled: false })
    assert.strictEqual(registry.client('crm'), undefined)
    assert.deepStrictEqual(made, ['http://127.0.0.1:1/mcp', 'http://127.0.0.1:2/mcp'])
  })

  it('o header de `auth: header` sai do cofre, com o nome configurado; sem segredo, nada', () => {
    const repository = new SqliteMcpServerRepository(':memory:')
    repository.insert(server({ auth: 'header', headerName: 'X-Api-Key' }))
    repository.insert(server({ id: 'outro', auth: 'caller' }))
    const secrets = new Map([
      ['mcp:crm', 'segredo'],
      ['mcp:outro', 'ignorado'],
    ])
    const registry = new McpRegistry(repository, { get: (key) => secrets.get(key) })

    assert.deepStrictEqual(registry.header('crm'), { name: 'X-Api-Key', value: 'segredo' })
    assert.strictEqual(registry.header('outro'), undefined)
    secrets.delete('mcp:crm')
    assert.strictEqual(registry.header('crm'), undefined)
  })

  it('⚖️ semente nova chega a um banco já semeado (marca por servidor); a antiga marca vale para o default', () => {
    const repository = new SqliteMcpServerRepository(':memory:')
    repository.seedOnce([server({ id: 'default' })])
    repository.delete('default')
    repository.seedOnce([server({ id: 'default' }), server({ id: 'gateway' })])
    assert.deepStrictEqual(
      repository.list().map((entry) => entry.id),
      ['gateway'],
    )
  })

  it('`caller` com header configurado: a credencial de quem chama vai no header pedido', async () => {
    const seen: Headers[] = []
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('nope', { status: 500 })
    }) as typeof fetch
    const client = new McpServerClient(
      'http://127.0.0.1:1/mcp',
      { fetch: fakeFetch },
      { auth: 'caller', callerHeader: 'X-Tool-Authorization', fixedHeaders: () => ({ Authorization: 'Bearer portao' }) },
    )
    await client.connect()
    assert.ok(seen.length > 0)
    assert.ok(seen.every((headers) => headers.get('authorization') === 'Bearer portao'))
  })

  it('a semente entra uma vez só: servidor apagado não volta no boot seguinte', () => {
    const repository = new SqliteMcpServerRepository(':memory:')
    repository.seedOnce([server({ id: 'default' })])
    repository.delete('default')
    repository.seedOnce([server({ id: 'default' })])
    assert.deepStrictEqual(repository.list(), [])
  })
})

describe('McpServerClient — listar como quem chama', () => {
  it('⚖️ `caller`: listToolsAs leva a credencial de quem pede (o botão "Testar conexão"); sem token, vai sem', async () => {
    const seen: Headers[] = []
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('nope', { status: 401 })
    }) as typeof fetch
    const client = new McpServerClient('http://127.0.0.1:1/mcp', { fetch: fakeFetch }, { auth: 'caller', callerHeader: 'X-Tool-Authorization' })

    await client.listToolsAs('tok-da-tela')
    assert.ok(seen.length > 0)
    assert.ok(seen.every((headers) => headers.get('x-tool-authorization') === 'Bearer tok-da-tela'))

    seen.length = 0
    await client.close()
    await client.connect()
    assert.ok(seen.every((headers) => !headers.has('x-tool-authorization')))
  })
})
