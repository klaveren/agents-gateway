import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { SqliteGuidanceRepository } from './Sqlite.GuidanceRepository'

describe('SqliteGuidanceRepository — índice de busca', () => {
  it('⚖️ banco antigo (sem o índice) ou índice fora de sincronia é reconstruído ao abrir', () => {
    const folder = mkdtempSync(join(tmpdir(), 'gw-guidance-'))
    const path = join(folder, 'gateway.db')
    try {
      const now = new Date()
      new SqliteGuidanceRepository(path).insertDoc({ id: 'api', kind: 'spec', title: 'API', summary: 'Rotas', body: 'Paginação por página.', createdAt: now, updatedAt: now })
      // O banco de antes do índice: os documentos existem, o índice não.
      const raw = new DatabaseSync(path)
      raw.exec('DELETE FROM docs_fts')
      raw.close()

      const reopened = new SqliteGuidanceRepository(path)
      assert.deepStrictEqual(
        reopened.searchDocs('"paginacao"*', [null]).map((hit) => hit.id),
        ['api'],
      )
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('SqliteGuidanceRepository — anexos dos recursos', () => {
  const now = new Date('2026-10-30T12:00:00.000Z')
  const resource = { id: 'contrato', kind: 'skill' as const, description: 'Aplica o contrato', body: 'Passos.', createdAt: now, updatedAt: now }

  it('docRefs vai e volta; sem ele, nada de docRefs (todos inteiros)', () => {
    const repository = new SqliteGuidanceRepository(':memory:')
    repository.saveResource({ ...resource, docIds: ['a', 'b'], docRefs: ['b'] })
    assert.deepStrictEqual([repository.resource('contrato')?.docIds, repository.resource('contrato')?.docRefs], [['a', 'b'], ['b']])
    repository.saveResource({ ...resource, docIds: ['a'] })
    assert.ok(!('docRefs' in repository.resource('contrato')!))
  })

  it('⚖️ banco antigo (sem a coluna doc_refs) ganha a coluna ao abrir, e o que já existia segue inteiro', () => {
    const folder = mkdtempSync(join(tmpdir(), 'gw-guidance-'))
    const path = join(folder, 'gateway.db')
    try {
      const raw = new DatabaseSync(path)
      raw.exec(`CREATE TABLE resources (id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT, description TEXT NOT NULL, body TEXT NOT NULL,
        doc_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`)
      raw
        .prepare('INSERT INTO resources (id, kind, description, body, doc_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('antiga', 'skill', 'De antes', 'Corpo.', '["a"]', now.toISOString(), now.toISOString())
      raw.close()

      const repository = new SqliteGuidanceRepository(path)
      const old = repository.resource('antiga')!
      assert.deepStrictEqual([old.docIds, old.docRefs], [['a'], undefined])
      repository.saveResource({ ...old, docRefs: ['a'] })
      assert.deepStrictEqual(new SqliteGuidanceRepository(path).resource('antiga')?.docRefs, ['a'])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
