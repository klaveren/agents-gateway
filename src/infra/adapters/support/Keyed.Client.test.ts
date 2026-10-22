import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { KeyedClient, MissingCredentialError } from './Keyed.Client'

describe('KeyedClient', () => {
  it('reusa o cliente enquanto a chave é a mesma, e refaz quando ela muda', () => {
    let key = 'k-1'
    const made: string[] = []
    const clients = new KeyedClient(EProvider.OPENAI, (value) => (made.push(value), { key: value }), { get: () => key })

    const first = clients.get()
    assert.strictEqual(clients.get(), first)
    key = 'k-2'
    assert.notStrictEqual(clients.get(), first)
    assert.deepStrictEqual(made, ['k-1', 'k-2'])
  })

  it('sem chave, lança dizendo onde configurar', () => {
    const clients = new KeyedClient(EProvider.CLAUDE, () => ({}), { get: () => undefined })

    assert.throws(
      () => clients.get(),
      (error: unknown) => error instanceof MissingCredentialError && error.message.includes('Providers'),
    )
  })

  it('o cliente injetado pelo teste nunca é trocado', () => {
    const fixed = { fixed: true }
    assert.strictEqual(new KeyedClient(EProvider.CLAUDE, () => ({ fixed: false }), { get: () => undefined }, fixed).get(), fixed)
  })
})
