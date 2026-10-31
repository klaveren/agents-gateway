import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IImportScan, IInventoryItem } from '@domain/models/ImportInventory.Model'
import { SqliteImportRepository } from '@infra/persistence/Sqlite.ImportRepository'
import { ImportBatchService } from './ImportBatch.Service'
import { ImportJobError, ImportJobService } from './ImportJob.Service'

function item(key: string, cites: string[] = []): IInventoryItem {
  const [kind, id] = key.split(':') as [IInventoryItem['kind'], string]
  return {
    key,
    kind,
    candidateId: id,
    detectors: ['agents-dir'],
    sources: [{ path: `${id}.md`, aliases: [], bytes: 40, tokens: 10, sha256: 'a'.repeat(64) }],
    refs: cites.map((cited) => ({ path: `${cited.split(':')[1]}.md`, item: cited })),
    unresolved: [],
    ...(kind === 'unknown' ? {} : { catalog: 'new' as const }),
    notes: [],
  }
}

const ITEMS = [
  item('knowledge:fila'),
  item('spec:guia', ['knowledge:fila']),
  item('spec:core-a', ['spec:core-b', 'spec:guia']),
  item('spec:core-b', ['spec:core-a']),
  item('skill:revisar', ['spec:guia']),
  item('unknown:notas', ['spec:guia']),
]

function setup() {
  let clock = Date.parse('2026-10-30T10:00:00.000Z')
  let seq = 0
  const repository = new SqliteImportRepository()
  const scan = (projectId: string, name: string): IImportScan => ({
    projectId,
    repository: name,
    scannedAt: new Date(clock),
    formats: ['agents-dir'],
    totals: { files: ITEMS.length, items: ITEMS.length, tokens: 60, byKind: {} },
    ignored: { dirs: {}, binaries: [], links: [], patterns: [] },
    items: ITEMS,
  })
  const jobs = new ImportJobService({ repository, scan, now: () => new Date(clock), newId: () => `j${++seq}` })
  const batches = new ImportBatchService({
    repository,
    catalogState: (query) => (query.projectId === 'alfa' && query.id === 'akm-fila' ? 'same-project' : 'new'),
    protocolTokens: () => 100,
    now: () => new Date(clock),
    newId: () => `b${++seq}`,
  })
  const tick = () => (clock += 60_000)
  return { repository, jobs, batches, tick }
}

const code = (expected: ImportJobError['code'], field?: string) => (error: unknown) => error instanceof ImportJobError && error.code === expected && error.field === field

describe('ImportBatchService — o lote por seleção de um trabalho', () => {
  it('a prévia calcula a ordem só entre os escolhidos e não grava nada', () => {
    const { jobs, batches } = setup()
    const job = jobs.create('alfa', 'app', 'ana@x.test')
    const plan = batches.plan('alfa', job.id, { keys: ['spec:core-b', 'spec:core-a', 'spec:guia'] })
    assert.deepStrictEqual(
      plan.steps.map((step) => step.key),
      ['spec:guia', 'spec:core-a', 'spec:core-b'],
    )
    assert.deepStrictEqual(
      plan.cycles.map((cycle) => cycle.keys),
      [['spec:core-a', 'spec:core-b']],
    )
    assert.deepStrictEqual(
      plan.outside.map((entry) => `${entry.state} ${entry.from} → ${entry.item}`),
      ['missing spec:guia → knowledge:fila'],
    )
    assert.strictEqual(plan.estimate.conversations, 3)
    assert.deepStrictEqual(batches.list('alfa', job.id), [])
  })

  it('lote salvo, ida e volta: nome, itens, ordem, prefixo, autor e hora; a lista e o abrir o devolvem', () => {
    const { jobs, batches, tick } = setup()
    const job = jobs.create('alfa', 'app', 'ana@x.test')
    tick()
    const saved = batches.create('alfa', job.id, { name: '  Knowledge  ', keys: ['knowledge:fila', 'spec:guia'], prefix: 'AKM-' }, 'ana@x.test')
    assert.deepStrictEqual(
      { ...saved, plan: undefined },
      {
        id: 'b2',
        jobId: job.id,
        name: 'Knowledge',
        prefix: 'akm-',
        keys: ['knowledge:fila', 'spec:guia'],
        order: ['knowledge:fila', 'spec:guia'],
        by: 'ana@x.test',
        at: new Date('2026-10-30T10:01:00.000Z'),
        plan: undefined,
      },
    )
    // `akm-fila` já existe neste projeto: o passo fica marcado e fora da estimativa.
    assert.strictEqual(saved.plan.steps[0].done, 'catalog')
    assert.strictEqual(saved.plan.estimate.conversations, 1)

    const { plan: _plan, ...record } = saved
    assert.deepStrictEqual(batches.list('alfa', job.id), [record])
    const opened = batches.get('alfa', job.id, saved.id)
    assert.deepStrictEqual({ ...opened, plan: undefined }, { ...saved, plan: undefined })
    assert.deepStrictEqual(opened.plan, saved.plan)
  })

  it('o outro lote, o aprovado e a reclassificação contam no cálculo de agora', () => {
    const { jobs, batches, repository } = setup()
    const job = jobs.create('alfa', 'app', 'ana@x.test')
    const first = batches.create('alfa', job.id, { name: 'base', keys: ['knowledge:fila'] }, 'ana')
    jobs.updateItem('alfa', job.id, 'unknown:notas', { kind: 'knowledge' }, 'ana')
    const plan = batches.plan('alfa', job.id, { keys: ['spec:guia', 'skill:revisar', 'unknown:notas'] })
    assert.deepStrictEqual(
      plan.outside.map((entry) => `${entry.state} ${entry.item} ${entry.batch?.name ?? ''}`.trim()),
      ['batch knowledge:fila base'],
    )
    assert.ok(
      plan.steps.some((step) => step.key === 'unknown:notas' && step.kind === 'knowledge'),
      'reclassificado: entra como knowledge',
    )
    assert.deepStrictEqual(plan.excluded, [])

    repository.updateItem(job.id, 'knowledge:fila', { state: 'approved' })
    assert.strictEqual(batches.plan('alfa', job.id, { keys: ['spec:guia'] }).outside[0].state, 'approved')
    // O lote salvo, aberto agora, vê o aprovado (e não se vê como "outro lote").
    const reopened = batches.get('alfa', job.id, first.id)
    assert.strictEqual(reopened.plan.steps[0].done, 'approved')
    assert.ok(!reopened.plan.notes.some((note) => note.code === 'other-batch'))
  })

  it('⛔ só o trabalho mais novo ganha lote; o antigo ainda mostra a prévia', () => {
    const { jobs, batches, tick } = setup()
    const old = jobs.create('alfa', 'app', 'ana')
    tick()
    jobs.create('alfa', 'app', 'ana')
    assert.throws(() => batches.create('alfa', old.id, { name: 'x', keys: ['spec:guia'] }, 'ana'), code('outdated'))
    assert.strictEqual(batches.plan('alfa', old.id, { keys: ['spec:guia'] }).steps.length, 1)
    assert.deepStrictEqual(batches.list('alfa', old.id), [])
  })

  it('pedido inválido no campo: seleção vazia ou fora do trabalho, prefixo, nome em branco', () => {
    const { jobs, batches } = setup()
    const job = jobs.create('alfa', 'app', 'ana')
    assert.throws(() => batches.plan('alfa', job.id, { keys: [] }), code('invalid', 'keys'))
    assert.throws(() => batches.plan('alfa', job.id, { keys: ['spec:guia', 'spec:nada'] }), code('invalid', 'keys'))
    assert.throws(() => batches.plan('alfa', job.id, { keys: ['spec:guia'], prefix: '../x' }), code('invalid', 'prefix'))
    assert.throws(() => batches.create('alfa', job.id, { name: '   ', keys: ['spec:guia'] }, 'ana'), code('invalid', 'name'))
    assert.deepStrictEqual(batches.list('alfa', job.id), [])
  })

  it('⛔ o trabalho e o lote de outro projeto não existem aqui', () => {
    const { jobs, batches } = setup()
    const theirs = jobs.create('beta', 'app', 'bia')
    const batch = batches.create('beta', theirs.id, { name: 'deles', keys: ['spec:guia'] }, 'bia')
    assert.throws(() => batches.plan('alfa', theirs.id, { keys: ['spec:guia'] }), code('not_found'))
    assert.throws(() => batches.list('alfa', theirs.id), code('not_found'))
    assert.throws(() => batches.get('alfa', theirs.id, batch.id), code('not_found'))
    const mine = jobs.create('alfa', 'app', 'ana')
    assert.throws(() => batches.get('alfa', mine.id, batch.id), code('not_found'))
  })
})
