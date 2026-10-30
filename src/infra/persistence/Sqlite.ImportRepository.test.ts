import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { IImportJobItem, INewImportJob } from '@domain/models/ImportJob.Model'
import { IInventoryItem } from '@domain/models/ImportInventory.Model'
import { SqliteImportRepository } from './Sqlite.ImportRepository'

function inventoryItem(key: string): IInventoryItem {
  const [kind, id] = key.split(':') as [IInventoryItem['kind'], string]
  return {
    key,
    kind,
    candidateId: id,
    detectors: ['agents-dir'],
    sources: [{ path: `.agents/${id}.md`, aliases: [`.claude/${id}.md`], bytes: 10, tokens: 3, sha256: 'a'.repeat(64), secret: true }],
    refs: [{ path: '.agents/x.md', item: 'spec:x' }],
    unresolved: ['sumiu.md'],
    catalog: 'new',
    notes: [{ level: 'attention', code: 'secret', text: 'segredo' }],
  }
}

function job(id: string, projectId: string, repository: string, at: string, items: IImportJobItem[]): INewImportJob {
  return {
    id,
    projectId,
    repository,
    head: 'abc123',
    dirty: false,
    scannedAt: new Date(at),
    by: 'ana@x.test',
    inventory: {
      projectId,
      repository,
      head: 'abc123',
      dirty: false,
      scannedAt: new Date(at),
      formats: ['agents-dir'],
      totals: { files: 3, items: items.length, tokens: 9, byKind: { skill: 1 } },
      ignored: { dirs: { node_modules: 2 }, binaries: [], links: [], patterns: [] },
    },
    items,
  }
}

describe('SqliteImportRepository', () => {
  it('ida e volta: o trabalho, o inventário e cada item com estado, reclassificação, autor e os campos dos PRs seguintes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-jobs-'))
    try {
      const path = join(dir, 'gateway.db')
      const first = new SqliteImportRepository(path)
      const at = new Date('2026-10-30T12:00:00.000Z')
      first.create({
        ...job('j1', 'alfa', 'app', '2026-10-30T11:00:00.000Z', [
          { key: 'skill:deploy', item: inventoryItem('skill:deploy'), state: 'pending', fingerprint: 'f1', drafts: [] },
          {
            key: 'unknown:notes',
            item: inventoryItem('unknown:notes'),
            state: 'stale',
            staleFrom: 'approved',
            kind: 'spec',
            fingerprint: 'f2',
            basis: 'f0',
            targetId: 'akm-notes',
            conversationId: 'c1',
            drafts: [{ kind: 'spec', id: 'akm-notes' }],
            review: { note: 'ok' },
            approvedBy: 'ana@x.test',
            approvedAt: at,
            batchId: 'b1',
            by: 'ana@x.test',
            at,
          },
        ]),
        previousId: 'j0',
        reuse: { from: 'j0', kept: 1, stale: ['unknown:notes'], restored: [], added: [], gone: ['skill:old'] },
      })

      // Outra conexão no mesmo arquivo: está gravado, não em memória.
      const second = new SqliteImportRepository(path)
      const record = second.get('alfa', 'j1')!
      assert.strictEqual(record.repository, 'app')
      assert.strictEqual(record.head, 'abc123')
      assert.strictEqual(record.dirty, false)
      assert.strictEqual(record.previousId, 'j0')
      assert.deepStrictEqual(record.reuse?.gone, ['skill:old'])
      assert.deepStrictEqual(record.inventory.ignored.dirs, { node_modules: 2 })
      assert.ok(record.inventory.scannedAt instanceof Date)

      const items = second.items('j1')
      assert.deepStrictEqual(
        items.map((entry) => entry.key),
        ['skill:deploy', 'unknown:notes'],
      )
      assert.deepStrictEqual(items[0], { key: 'skill:deploy', item: inventoryItem('skill:deploy'), state: 'pending', fingerprint: 'f1', drafts: [] })
      const notes = items[1]
      assert.strictEqual(notes.kind, 'spec')
      assert.strictEqual(notes.staleFrom, 'approved')
      assert.strictEqual(notes.basis, 'f0')
      assert.deepStrictEqual(notes.drafts, [{ kind: 'spec', id: 'akm-notes' }])
      assert.deepStrictEqual(notes.review, { note: 'ok' })
      assert.strictEqual(notes.approvedAt?.toISOString(), at.toISOString())
      assert.strictEqual(notes.at?.toISOString(), at.toISOString())
      assert.deepStrictEqual(notes.item, inventoryItem('unknown:notes'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a mudança do item: estado, reclassificação (null volta ao detectado), base e autor', () => {
    const repository = new SqliteImportRepository()
    repository.create(
      job('j1', 'alfa', 'app', '2026-10-30T11:00:00.000Z', [{ key: 'skill:deploy', item: inventoryItem('skill:deploy'), state: 'pending', fingerprint: 'f1', drafts: [] }]),
    )
    const at = new Date('2026-10-30T13:00:00.000Z')
    const updated = repository.updateItem('j1', 'skill:deploy', { state: 'skipped', kind: 'command', basis: 'f1', by: 'bia', at })!
    assert.deepStrictEqual([updated.state, updated.kind, updated.basis, updated.by, updated.at?.toISOString()], ['skipped', 'command', 'f1', 'bia', at.toISOString()])
    const back = repository.updateItem('j1', 'skill:deploy', { kind: null, staleFrom: null })!
    assert.strictEqual(back.kind, undefined)
    assert.strictEqual(back.state, 'skipped')
    assert.strictEqual(repository.updateItem('j1', 'skill:nada', { state: 'pending' }), undefined)
  })

  it('a lista do projeto: mais novo primeiro, contagem por estado e o mais novo de cada repositório; outro projeto não aparece', () => {
    const repository = new SqliteImportRepository()
    const pending = (key: string): IImportJobItem => ({ key, item: inventoryItem(key), state: 'pending', fingerprint: 'f', drafts: [] })
    repository.create(job('j1', 'alfa', 'app', '2026-10-30T10:00:00.000Z', [pending('skill:a'), { ...pending('skill:b'), state: 'skipped' }]))
    repository.create(job('j2', 'alfa', 'app', '2026-10-30T11:00:00.000Z', [pending('skill:a')]))
    repository.create(job('j3', 'alfa', 'lib', '2026-10-30T10:30:00.000Z', []))
    repository.create(job('j4', 'beta', 'app', '2026-10-30T12:00:00.000Z', [pending('skill:a')]))

    const list = repository.list('alfa')
    assert.deepStrictEqual(
      list.map((entry) => [entry.id, entry.latest, entry.items, entry.byState]),
      [
        ['j2', true, 1, { pending: 1 }],
        ['j3', true, 0, {}],
        ['j1', false, 2, { pending: 1, skipped: 1 }],
      ],
    )
    assert.ok(!('inventory' in list[0]))
    assert.strictEqual(repository.latest('alfa', 'app')?.id, 'j2')
    assert.strictEqual(repository.get('alfa', 'j4'), undefined, 'o trabalho de outro projeto não existe aqui')
  })

  it('apagar o projeto apaga os trabalhos e os itens dele, e só os dele', () => {
    const repository = new SqliteImportRepository()
    const pending = (key: string): IImportJobItem => ({ key, item: inventoryItem(key), state: 'pending', fingerprint: 'f', drafts: [] })
    repository.create(job('j1', 'alfa', 'app', '2026-10-30T10:00:00.000Z', [pending('skill:a')]))
    repository.create(job('j2', 'beta', 'app', '2026-10-30T10:00:00.000Z', [pending('skill:a')]))
    repository.deleteProject('alfa')
    assert.deepStrictEqual(repository.list('alfa'), [])
    assert.deepStrictEqual(repository.items('j1'), [])
    assert.strictEqual(repository.items('j2').length, 1)
  })

  it('⚖️ o trabalho grava inteiro ou nada: item repetido desfaz o cabeçalho', () => {
    const repository = new SqliteImportRepository()
    const pending = (key: string): IImportJobItem => ({ key, item: inventoryItem(key), state: 'pending', fingerprint: 'f', drafts: [] })
    assert.throws(() => repository.create(job('j1', 'alfa', 'app', '2026-10-30T10:00:00.000Z', [pending('skill:a'), pending('skill:a')])))
    assert.strictEqual(repository.get('alfa', 'j1'), undefined)
  })
})
