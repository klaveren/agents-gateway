import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { IPermissionRequest } from '@domain/models/PermissionRequest.Model'
import { SqlitePermissionRequestRepository } from './Sqlite.PermissionRequestRepository'

const request = (id: string, extra: Partial<IPermissionRequest> = {}): IPermissionRequest => ({
  id,
  kind: 'agent-patch',
  agentId: 'theo',
  add: [],
  remove: [],
  widenings: [{ key: 'agent/theo#allowedTools+agent:ana', description: 'delegar à Ana' }],
  reason: 'delegar',
  requestedBy: { by: 'root@x.test', agentId: 'theo' },
  baseHash: 'h',
  createdAt: new Date('2026-11-04T10:00:00Z'),
  status: 'pending',
  ...extra,
})

describe('SqlitePermissionRequestRepository', () => {
  it('guarda e devolve o item: a entrada de lista e o lote', () => {
    const repository = new SqlitePermissionRequestRepository()
    repository.create(request('a', { entries: { field: 'allowedTools', add: ['agent:ana'] }, batchId: 'a' }))
    repository.create(request('b', { patch: { role: null } }))
    assert.deepStrictEqual([repository.get('a')?.entries, repository.get('a')?.batchId], [{ field: 'allowedTools', add: ['agent:ana'] }, 'a'])
    assert.deepStrictEqual([repository.get('b')?.entries, repository.get('b')?.batchId, repository.get('b')?.patch], [undefined, undefined, { role: null }])
  })

  it('⚖️ banco de antes (sem as colunas novas): ganha as colunas ao abrir, e os pedidos antigos seguem lidos', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-permreq-'))
    try {
      const path = join(dir, 'gateway.db')
      const old = new DatabaseSync(path)
      old.exec(`CREATE TABLE permission_requests (id TEXT NOT NULL PRIMARY KEY, kind TEXT NOT NULL, agent_id TEXT, project_id TEXT, add_rules TEXT NOT NULL,
        remove_rules TEXT NOT NULL, patch TEXT, widenings TEXT NOT NULL, reason TEXT NOT NULL, requested_by TEXT NOT NULL, base_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_at TEXT, decision_note TEXT)`)
      old
        .prepare(
          `INSERT INTO permission_requests (id, kind, agent_id, add_rules, remove_rules, widenings, reason, requested_by, base_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('velho', 'agent-rules', 'theo', '[]', '[]', '[]', 'x', '{"by":"root@x.test"}', 'h', '2026-11-01T00:00:00Z')
      old.close()
      const repository = new SqlitePermissionRequestRepository(path)
      assert.strictEqual(repository.get('velho')?.batchId, undefined)
      repository.create(request('novo', { batchId: 'novo' }))
      assert.strictEqual(repository.get('novo')?.batchId, 'novo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
