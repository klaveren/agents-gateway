import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { SqlitePersonMessageRepository } from './Sqlite.PersonMessageRepository'

const LEGACY = `
  CREATE TABLE person_messages (
    id TEXT NOT NULL PRIMARY KEY, recipient_id TEXT NOT NULL, conversation_id TEXT NOT NULL, project_id TEXT, agent_id TEXT NOT NULL,
    sender TEXT NOT NULL, author_id TEXT, title TEXT, body TEXT NOT NULL, level TEXT NOT NULL, turn INTEGER, created_at TEXT NOT NULL,
    read_at TEXT, archived_at TEXT
  );
`

describe('Sqlite.PersonMessageRepository: migração do estado dos pedidos', () => {
  it('banco antigo ganha as colunas; pedido antigo é answered se há resposta da pessoa depois, senão pending; info fica sem estado', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'pm-')), 'c.db')
    const db = new DatabaseSync(path)
    db.exec(LEGACY)
    const insert = db.prepare('INSERT INTO person_messages (id, recipient_id, conversation_id, agent_id, sender, body, level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    insert.run('a1', 'u', 'c1', 'zeus', 'agent', 'um', 'attention', '2026-01-01T10:00:00.000Z')
    insert.run('p1', 'u', 'c1', 'zeus', 'person', 'resp', 'info', '2026-01-01T11:00:00.000Z')
    insert.run('a2', 'u', 'c1', 'zeus', 'agent', 'dois', 'urgent', '2026-01-01T12:00:00.000Z')
    insert.run('i1', 'u', 'c1', 'zeus', 'agent', 'aviso', 'info', '2026-01-01T12:30:00.000Z')
    insert.run('a3', 'u', 'c2', 'zeus', 'agent', 'outro fio', 'attention', '2026-01-01T09:00:00.000Z')
    db.close()

    const repository = new SqlitePersonMessageRepository(path)
    const [a1, p1, a2, i1] = repository.thread('u', 'c1')
    assert.deepStrictEqual([a1.status, a1.answeredAt?.toISOString(), p1.status, a2.status, i1.status], ['answered', '2026-01-01T11:00:00.000Z', undefined, 'pending', undefined])
    assert.strictEqual(repository.thread('u', 'c2')[0].status, 'pending')
    assert.deepStrictEqual([repository.pending('u'), repository.threads('u').map((thread) => thread.pending).sort()], [2, [1, 1]])

    // Reabrir o banco não refaz a migração nem a regra: o que a pessoa mudou depois fica.
    assert.strictEqual(repository.setStatus('u', 'c1', 'a2', 'resolved', new Date()), 1)
    const again = new SqlitePersonMessageRepository(path)
    assert.strictEqual(again.thread('u', 'c1')[2].status, 'resolved')
  })

  it('setStatus: só pedido do agente do destinatário; resolved guarda o answeredAt, pending o limpa', () => {
    const repository = new SqlitePersonMessageRepository(':memory:')
    const base = { recipientId: 'u', conversationId: 'c', agentId: 'zeus', body: 'b', createdAt: new Date('2026-01-01T10:00:00Z') }
    repository.insert({ ...base, id: 'r', from: 'agent', level: 'attention', status: 'pending' })
    repository.insert({ ...base, id: 'i', from: 'agent', level: 'info' })
    const at = new Date('2026-01-02T00:00:00Z')
    assert.strictEqual(repository.setStatus('u', 'c', 'i', 'resolved', at), 0)
    assert.strictEqual(repository.setStatus('x', 'c', 'r', 'resolved', at), 0)
    assert.strictEqual(repository.setStatus('u', 'c', 'r', 'answered', at), 1)
    assert.strictEqual(repository.setStatus('u', 'c', 'r', 'resolved', new Date()), 1)
    assert.strictEqual(repository.thread('u', 'c')[0].answeredAt?.toISOString(), at.toISOString())
    repository.setStatus('u', 'c', 'r', 'pending', at)
    assert.deepStrictEqual([repository.thread('u', 'c')[0].status, repository.thread('u', 'c')[0].answeredAt], ['pending', undefined])
  })
})
