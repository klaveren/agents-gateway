import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SqliteAuditRepository } from './Sqlite.AuditRepository'

describe('SqliteAuditRepository — as páginas', () => {
  const seeded = () => {
    const repository = new SqliteAuditRepository()
    for (let index = 1; index <= 7; index++)
      repository.append({ at: new Date(Date.UTC(2026, 10, 12, 10, index)), action: index % 2 ? 'POST /agents' : 'PUT /settings', status: index === 4 ? 422 : 200 })
    return repository
  }

  it('`offset` pula os mais novos; `count` é o recorte inteiro, sem a página', () => {
    const repository = seeded()
    const ids = (offset: number) => repository.query({ limit: 3, offset }).map((event) => event.id)
    assert.deepStrictEqual([ids(0), ids(3), ids(6)], [[7, 6, 5], [4, 3, 2], [1]])
    assert.strictEqual(repository.count({ limit: 3, offset: 3 }), 7)
    assert.strictEqual(repository.count({ action: 'agents' }), 4)
    assert.strictEqual(repository.count({ failed: true }), 1)
    // O cursor continua valendo para quem pagina por `before`; a contagem o ignora.
    assert.deepStrictEqual(
      repository.query({ limit: 2, before: 5 }).map((event) => event.id),
      [4, 3],
    )
    assert.strictEqual(repository.count({ before: 5 }), 7)
  })
})
