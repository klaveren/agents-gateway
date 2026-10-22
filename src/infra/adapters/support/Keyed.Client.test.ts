import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IProviderConnection } from '@domain/models/Provider.Model'
import { KeyedClient, MissingCredentialError, UnavailableProviderError } from './Keyed.Client'

const source = (connections: Record<string, Partial<IProviderConnection> | undefined>) => ({
  connection: (id: string) => (connections[id] ? ({ providerId: id, name: id, protocol: EProvider.OPENAI, ...connections[id] } as IProviderConnection) : undefined),
})

describe('KeyedClient', () => {
  it('reusa o cliente enquanto chave e URL são as mesmas, e refaz quando mudam', () => {
    const connections: Record<string, Partial<IProviderConnection>> = { openai: { key: 'k-1' } }
    const made: string[] = []
    const clients = new KeyedClient(EProvider.OPENAI, (connection) => (made.push(`${connection.baseUrl ?? '-'}|${connection.key}`), { connection }), source(connections))

    const first = clients.get('openai')
    assert.strictEqual(clients.get('openai'), first)
    connections.openai = { key: 'k-2' }
    assert.notStrictEqual(clients.get('openai'), first)
    connections.openai = { key: 'k-2', baseUrl: 'https://openrouter.ai/api/v1' }
    clients.get('openai')
    assert.deepStrictEqual(made, ['-|k-1', '-|k-2', 'https://openrouter.ai/api/v1|k-2'])
  })

  it('um cliente por provider: o oficial e o compatível do mesmo protocolo não se misturam', () => {
    const clients = new KeyedClient(
      EProvider.OPENAI,
      (connection) => ({ connection }),
      source({ openai: { key: 'k-oficial' }, openrouter: { key: 'k-or', baseUrl: 'https://openrouter.ai/api/v1' } }),
    )

    assert.strictEqual(clients.get('openai').connection.compatible, false)
    assert.deepStrictEqual(clients.get('openrouter').connection, { key: 'k-or', baseUrl: 'https://openrouter.ai/api/v1', compatible: true })
  })

  it('sem chave: lança dizendo onde configurar; provider sumido ou desligado: lança dizendo isso', () => {
    const clients = new KeyedClient(EProvider.CLAUDE, () => ({}), source({ claude: {} }))

    assert.throws(
      () => clients.get('claude'),
      (error: unknown) => error instanceof MissingCredentialError && error.message.includes('Providers'),
    )
    assert.throws(() => clients.get('removido'), UnavailableProviderError)
  })

  it('o cliente injetado pelo teste nunca é trocado', () => {
    const fixed = { fixed: true }
    assert.strictEqual(new KeyedClient(EProvider.CLAUDE, () => ({ fixed: false }), source({}), fixed).get('claude'), fixed)
  })
})
