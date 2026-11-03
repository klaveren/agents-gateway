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
  const state = (job: { states: Array<{ key: string; state: string; staleFrom?: string; kind?: string; goneAt?: Date }> }, key: string) =>
    job.states.find((entry) => entry.key === key)
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
    assert.deepStrictEqual(job.byState, { pending: 2 })
    assert.deepStrictEqual([job.analysis.added, job.analysis.kept, job.analyses.length], [['skill:deploy', 'spec:base'], 0, 1])
    assert.deepStrictEqual(
      job.scan.items.map((entry) => entry.key),
      ['skill:deploy', 'spec:base'],
    )
    assert.ok(job.states.every((entry) => !('basis' in entry)))
    const { analysis: _analysis, ...opened } = job
    assert.deepStrictEqual(service.get('alfa', 'j1'), opened)
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

  it('reanalisar ATUALIZA a mesma importação (o id não muda) e mantém estado e reclassificação da fonte igual', () => {
    const { files, service, tick, state } = setup()
    files.set('unknown:notes', 'a').set('skill:deploy', 'b')
    service.create('alfa', 'app', 'ana', {})
    service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    service.updateItem('alfa', 'j1', 'unknown:notes', { kind: 'spec' }, 'bia')
    tick()
    const again = service.create('alfa', 'app', 'caio', {})
    assert.strictEqual(again.id, 'j1')
    assert.deepStrictEqual(
      service.list('alfa').map((entry) => [entry.id, entry.by, entry.analyses.length]),
      [['j1', 'caio', 2]],
    )
    const { at: _at, ...analysis } = again.analysis
    assert.deepStrictEqual(analysis, { by: 'caio', head: 'h1', dirty: false, kept: 2, stale: [], added: [], gone: [], restored: [], returned: [] })
    assert.strictEqual(again.analyses[0].by, 'caio')
    assert.strictEqual(state(again, 'skill:deploy')?.state, 'skipped')
    assert.strictEqual(state(again, 'unknown:notes')?.kind, 'spec')
    assert.strictEqual((state(again, 'skill:deploy') as { by?: string }).by, 'bia')
  })

  it('reanalisar com a fonte mudada marca stale no lugar; o pendente continua pendente; o novo entra; o que saiu fica marcado e volta', () => {
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
    assert.deepStrictEqual(
      [again.analysis.kept, again.analysis.stale, again.analysis.added, again.analysis.gone, again.analysis.returned],
      [1, ['skill:deploy'], ['rule:nova'], ['command:ship'], []],
    )
    // ⚖️ O que saiu da fonte FICA, com o estado e a marca; não é um estado novo.
    const ship = again.states.find((entry) => entry.key === 'command:ship')
    assert.deepStrictEqual([ship?.state, ship?.goneAt?.toISOString()], ['pending', '2026-10-30T10:01:00.000Z'])
    assert.strictEqual(again.gone, 1)
    assert.ok(
      again.scan.items.some((entry) => entry.key === 'command:ship'),
      'o inventário guarda o item que saiu',
    )

    // De novo sem ele: não conta como "saiu" outra vez, e a data de quando saiu fica.
    tick()
    const still = service.create('alfa', 'app', 'ana', {})
    assert.deepStrictEqual(still.analysis.gone, [])
    assert.strictEqual(state(still, 'command:ship')?.goneAt?.toISOString(), '2026-10-30T10:01:00.000Z')

    // A fonte de volta à da decisão: o estado de antes volta; o que saiu volta e perde a marca.
    tick()
    files.set('skill:deploy', 'a').set('command:ship', 'c')
    const back = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(state(back, 'skill:deploy')?.state, 'skipped')
    assert.strictEqual(state(back, 'skill:deploy')?.staleFrom, undefined)
    assert.deepStrictEqual([back.analysis.restored, back.analysis.returned], [['skill:deploy'], ['command:ship']])
    assert.strictEqual(state(back, 'command:ship')?.goneAt, undefined)
    assert.strictEqual(back.gone, 0)
    assert.deepStrictEqual(
      back.analyses.map((entry) => entry.added.length),
      [0, 0, 1, 3],
    )
  })

  it('reanalisar não mexe no processado da fonte igual (rascunho, aprovação, conversa, lote); o que saiu com rascunho continua com ele', () => {
    const { files, service, repository, tick, state } = setup()
    files.set('skill:deploy', 'a').set('spec:base', 'b')
    service.create('alfa', 'app', 'ana', {})
    const draft = { ops: [], removals: [] }
    repository.updateItem('j1', 'skill:deploy', { state: 'approved', conversationId: 'c1', drafts: [draft], basis: 'x', approvedBy: 'bia' })
    repository.updateItem('j1', 'skill:deploy', { basis: repository.item('j1', 'skill:deploy')!.fingerprint })
    repository.updateItem('j1', 'spec:base', { state: 'review', conversationId: 'c2', drafts: [draft], basis: repository.item('j1', 'spec:base')!.fingerprint })
    repository.createBatch({ id: 'b1', jobId: 'j1', name: 'tudo', prefix: '', keys: ['skill:deploy', 'spec:base'], order: [], by: 'ana', at: new Date() })
    tick()
    files.delete('spec:base')
    const again = service.create('alfa', 'app', 'ana', {})
    const deploy = repository.item('j1', 'skill:deploy')!
    assert.deepStrictEqual([deploy.state, deploy.conversationId, deploy.drafts.length, deploy.approvedBy], ['approved', 'c1', 1, 'bia'])
    const base = repository.item('j1', 'spec:base')!
    assert.deepStrictEqual([base.state, base.conversationId, base.drafts.length, !!base.goneAt], ['review', 'c2', 1, true])
    assert.strictEqual(state(again, 'spec:base')?.state, 'review')
    assert.deepStrictEqual(
      repository.batches('j1').map((batch) => batch.keys),
      [['skill:deploy', 'spec:base']],
    )
  })

  it('decidir de novo um stale grava a fonte de agora como base', () => {
    const { files, service, tick, state } = setup()
    files.set('skill:deploy', 'a')
    service.create('alfa', 'app', 'ana', {})
    service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia')
    tick()
    files.set('skill:deploy', 'x')
    assert.strictEqual(state(service.create('alfa', 'app', 'ana', {}), 'skill:deploy')?.state, 'stale')
    assert.strictEqual(service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'skipped' }, 'bia').state, 'skipped')
    tick()
    const again = service.create('alfa', 'app', 'ana', {})
    assert.strictEqual(state(again, 'skill:deploy')?.state, 'skipped')
  })

  it('⛔ transição e reclassificação fora da regra são recusadas', () => {
    const { files, service, repository, tick } = setup()
    files.set('skill:deploy', 'a')
    service.create('alfa', 'app', 'ana', {})
    tick()
    // A reanálise atualiza a mesma importação: o id `j1` continua valendo (o `j2` nunca nasce).
    service.create('alfa', 'app', 'ana', {})
    assert.throws(
      () => service.get('alfa', 'j2'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'not_found',
    )

    // Um item com rascunho a revisar (o PR 7 o põe lá) não reclassifica, e "incluir" não é transição de `review`.
    repository.updateItem('j1', 'skill:deploy', { state: 'review' })
    assert.throws(
      () => service.updateItem('alfa', 'j1', 'skill:deploy', { kind: 'command' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'reclassify',
    )
    assert.throws(
      () => service.updateItem('alfa', 'j1', 'skill:deploy', { state: 'pending' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'transition',
    )

    // No construtor SEM rascunho reclassifica: sai da conversa e volta à fila. Com rascunho, não.
    repository.updateItem('j1', 'skill:deploy', { state: 'drafting', conversationId: 'c1', drafts: [{ ops: [], removals: [] }] })
    assert.throws(
      () => service.updateItem('alfa', 'j1', 'skill:deploy', { kind: 'command' }, 'bia'),
      (error: unknown) => error instanceof ImportJobError && error.code === 'reclassify',
    )
    repository.updateItem('j1', 'skill:deploy', { drafts: [] })
    const moved = service.updateItem('alfa', 'j1', 'skill:deploy', { kind: 'command' }, 'bia')
    assert.deepStrictEqual([moved.kind, moved.state, moved.conversationId], ['command', 'pending', undefined])
    assert.throws(
      () => service.updateItem('alfa', 'j1', 'skill:nada', { state: 'skipped' }, 'bia'),
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
