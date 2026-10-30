import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IImportScan, IInventoryItem } from '@domain/models/ImportInventory.Model'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { ImportJobError, ImportJobService } from './ImportJob.Service'

function item(key: string, sha = 'a'): IInventoryItem {
  const [kind, id] = key.split(':') as [IInventoryItem['kind'], string]
  return {
    key,
    kind,
    candidateId: id,
    detectors: ['agents-dir'],
    sources: [{ path: `${id}.md`, aliases: [], bytes: 1, tokens: 1, sha256: sha.repeat(64) }],
    refs: [],
    unresolved: [],
    notes: [],
  }
}

/** Um repositório falso: cada análise devolve o que `files` tem agora (chave → sha). */
function setup() {
  const files = new Map<string, string>()
  let clock = Date.parse('2026-10-30T10:00:00.000Z')
  let seq = 0
  const repository = new SqliteImportRepository()
  const scan = (projectId: string, name: string): IImportScan => {
    if (name === 'fora') throw new Error('repository is not in this project')
    const items = [...files.entries()].map(([key, sha]) => item(key, sha))
    return {
      projectId,
      repository: name,
      head: `h${seq}`,
      dirty: false,
      scannedAt: new Date(clock),
      formats: ['agents-dir'],
      totals: { files: items.length, items: items.length, tokens: items.length, byKind: {} },
      ignored: { dirs: {}, binaries: [], links: [], patterns: [] },
      items,
    }
  }
  const service = new ImportJobService({
    repository,
    scan,
    now: () => new Date(clock),
    newId: () => `j${++seq}`,
  })
  const tick = () => (clock += 60_000)
  const state = (job: { states: Array<{ key: string; state: string; staleFrom?: string; kind?: string }> }, key: string) => job.states.find((entry) => entry.key === key)
  return { files, service, repository, tick, state }
}

describe('ImportJobService', () => {
  it('analisar salva o trabalho com todos os itens pendentes; abrir devolve o inventário e os estados', () => {
    const { files, service } = setup()
    files.set('skill:deploy', 'a').set('spec:base', 'b')
    const job = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(job.id, 'j1')
    assert.strictEqual(job.by, 'ana')
    assert.strictEqual(job.latest, true)
    assert.strictEqual(job.reuse, undefined)
    assert.deepStrictEqual(job.byState, { pending: 2 })
    assert.deepStrictEqual(
      job.scan.items.map((entry) => entry.key),
      ['skill:deploy', 'spec:base'],
    )
    assert.ok(job.states.every((entry) => !('basis' in entry)))
    assert.deepStrictEqual(service.get('alfa', 'j1'), job)
    assert.deepStrictEqual(
      service.list('alfa').map((entry) => entry.id),
      ['j1'],
    )
  })

  it('excluir e incluir gravam quem e quando; a reclassificação persiste e volta ao detectado com null', () => {
    const { files, service, tick, state } = setup()
    files.set('unknown:notes', 'a').set('skill:deploy', 'b')
    service.create('alfa', 'app', 'ana', {})
    tick()
    const skipped = service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    assert.deepStrictEqual([skipped.state, skipped.by, skipped.at?.toISOString()], ['skipped', 'bia', '2026-10-30T10:01:00.000Z'])
    const reclassified = service.updateItem('alfa', 'j1', 'unknown:notes', { kind: 'spec' }, 'bia')
    assert.deepStrictEqual([reclassified.kind, reclassified.state], ['spec', 'pending'])

    const reopened = service.get('alfa', 'j1')
    assert.strictEqual(state(reopened, 'unknown:notes')?.kind, 'spec')
    assert.strictEqual(state(reopened, 'skill:deploy')?.state, 'skipped')
    assert.deepStrictEqual(reopened.byState, { pending: 1, skipped: 1 })

    assert.strictEqual(service.updateItem('alfa', 'j1', 'unknown:notes', { kind: null }, 'bia').kind, undefined)
    assert.strictEqual(service.updateItem('alfa', 'j1', 'unknown:notes', { kind: 'unknown' }, 'bia').kind, undefined, 'o detectado não é reclassificação')
    assert.strictEqual(service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'pending' }, 'ana').state, 'pending')
  })

  it('reanalisar com a fonte igual mantém estado e reclassificação', () => {
    const { files, service, tick, state } = setup()
    files.set('unknown:notes', 'a').set('skill:deploy', 'b')
    service.create('alfa', 'app', 'ana', {})
    service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    service.updateItem('alfa', 'j1', 'unknown:notes', { kind: 'spec' }, 'bia')
    tick()
    const again = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(again.previousId, 'j1')
    assert.deepStrictEqual(again.reuse, { from: 'j1', kept: 2, stale: [], restored: [], added: [], gone: [] })
    assert.strictEqual(state(again, 'skill:deploy')?.state, 'skipped')
    assert.strictEqual(state(again, 'unknown:notes')?.kind, 'spec')
    assert.strictEqual((state(again, 'skill:deploy') as { by?: string }).by, 'bia')
  })

  it('reanalisar com a fonte mudada marca stale o que tinha decisão; o pendente continua pendente; o novo entra e o sumido é contado', () => {
    const { files, service, tick, state } = setup()
    files.set('skill:deploy', 'a').set('spec:base', 'b').set('command:ship', 'c')
    service.create('alfa', 'app', 'ana', {})
    service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    tick()
    files.set('skill:deploy', 'x').set('spec:base', 'y').delete('command:ship')
    files.set('rule:nova', 'n')
    const again = service.create('alfa', 'app', 'ana', {})
    assert.deepStrictEqual(state(again, 'skill:deploy'), { ...state(again, 'skill:deploy'), state: 'stale', staleFrom: 'skipped' })
    assert.strictEqual(state(again, 'spec:base')?.state, 'pending')
    assert.strictEqual(state(again, 'rule:nova')?.state, 'pending')
    assert.deepStrictEqual(again.reuse, { from: 'j1', kept: 1, stale: ['skill:deploy'], restored: [], added: ['rule:nova'], gone: ['command:ship'] })

    // A fonte de volta à da decisão: o estado de antes volta.
    tick()
    files.set('skill:deploy', 'a')
    const back = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(state(back, 'skill:deploy')?.state, 'skipped')
    assert.strictEqual(state(back, 'skill:deploy')?.staleFrom, undefined)
    assert.deepStrictEqual(back.reuse?.restored, ['skill:deploy'])
  })

  it('decidir de novo um stale grava a fonte de agora como base', () => {
    const { files, service, tick, state } = setup()
    files.set('skill:deploy', 'a')
    service.create('alfa', 'app', 'ana', {})
    service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    tick()
    files.set('skill:deploy', 'x')
    service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(service.updateItem('alfa', 'j2', 'skill:deploy', { state: 'skipped' }, 'bia').state, 'skipped')
    tick()
    const again = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(state(again, 'skill:deploy')?.state, 'skipped')
  })

  it('⛔ só o trabalho mais novo do repositório muda; transição e reclassificação fora da regra são recusadas', () => {
    const { files, service, repository, tick } = setup()
    files.set('skill:deploy', 'a')
    service.create('alfa', 'app', 'ana', {})
    tick()
    service.create('alfa', 'app', 'ana', {})
    assert.throws(
      () => service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'outdated',
    )
    assert.strictEqual(service.get('alfa', 'j1').latest, false)

    // Um item com rascunho a revisar (o PR 7 o põe lá) não reclassifica, e "incluir" não é transição de `review`.
    repository.updateItem('j2', 'skill:deploy', { state: 'review' })
    assert.throws(
      () => service.updateItem('alfa', 'j2', 'skill:deploy', { kind: 'command' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'reclassify',
    )
    assert.throws(
      () => service.updateItem('alfa', 'j2', 'skill:deploy', { state: 'pending' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'transition',
    )
    assert.throws(
      () => service.updateItem('alfa', 'j2', 'skill:nada', { state: 'skipped' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'not_found' && error.field === 'key',
    )
  })

  it('⛔ o trabalho de outro projeto não existe aqui; a varredura que falha não salva nada; apagar o projeto apaga os trabalhos', () => {
    const { files, service } = setup()
    files.set('skill:deploy', 'a')
    service.create('alfa', 'app', 'ana', {})
    assert.throws(
      () => service.get('beta', 'j1'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'not_found',
    )
    assert.throws(
      () => service.updateItem('beta', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'not_found',
    )
    assert.throws(() => service.create('alfa', 'fora', 'ana', {}))
    assert.strictEqual(service.list('alfa').length, 1)
    service.removeProject('alfa')
    assert.deepStrictEqual(service.list('alfa'), [])
  })
})
