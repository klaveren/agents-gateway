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
