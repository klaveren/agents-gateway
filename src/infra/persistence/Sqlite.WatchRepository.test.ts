import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IWatch } from '@domain/models/Watch.Model'
import { SqliteWatchRepository } from './Sqlite.WatchRepository'

const at = (iso: string) => new Date(`2026-01-01T${iso}Z`)
const watch = (id: string, over: Partial<IWatch> = {}): IWatch => ({
  id,
  sessionId: 's1',
  agentId: 'a',
  runAs: 'u',
  kind: 'command',
  label: 'rótulo',
  command: 'true',
  everySeconds: 60,
  then: 'seguir',
  status: 'active',
  createdAt: at('10:00:00'),
  nextCheckAt: at('10:01:00'),
  deadlineAt: at('11:00:00'),
  checks: 0,
  failures: 0,
  delivered: false,
  deliveryAttempts: 0,
  ...over,
})

describe('SqliteWatchRepository', () => {
  it('grava e lê de volta inteira', () => {
    const repository = new SqliteWatchRepository()
    const full = watch('w1', { lastOutput: 'saída', checks: 3, failures: 1 })
    repository.insert(full)
    assert.deepStrictEqual(repository.find('w1'), full)
    const { command: _command, everySeconds: _every, ...rest } = watch('w2', { kind: 'timer', createdAt: at('10:00:01') })
    const timer: IWatch = rest
    repository.insert(timer)
    assert.deepStrictEqual(repository.find('w2'), timer)
    assert.strictEqual(repository.find('nada'), undefined)
    assert.deepStrictEqual(
      repository.listBySession('s1').map((item) => item.id),
      ['w2', 'w1'],
    )
  })

  it('conta as ativas, da conversa e do gateway', () => {
    const repository = new SqliteWatchRepository()
    repository.insert(watch('w1'))
    repository.insert(watch('w2', { sessionId: 's2' }))
    repository.insert(watch('w3', { status: 'met' }))
    assert.strictEqual(repository.countActive('s1'), 1)
    assert.strictEqual(repository.countActive(), 2)
  })

  it('lista o que venceu: conferência, prazo e entrega pendente', () => {
    const repository = new SqliteWatchRepository()
    repository.insert(watch('conferir'))
    repository.insert(watch('cedo', { nextCheckAt: at('10:30:00') }))
    repository.insert(watch('prazo', { kind: 'timer', nextCheckAt: at('10:00:30'), deadlineAt: at('10:00:30') }))
    repository.insert(watch('pendente', { status: 'met', endedAt: at('10:00:10'), nextCheckAt: undefined }))
    repository.insert(watch('adiada', { status: 'met', endedAt: at('10:00:10'), nextCheckAt: at('10:20:00') }))
    repository.insert(watch('entregue', { status: 'met', endedAt: at('10:00:10'), nextCheckAt: undefined, delivered: true }))
    assert.deepStrictEqual(
      repository
        .listDue(at('10:01:00'))
        .map((item) => item.id)
        .sort(),
      ['conferir', 'pendente', 'prazo'],
    )
    assert.deepStrictEqual(
      repository.listDue(at('09:00:00')).map((item) => item.id),
      ['pendente'],
    )
  })

  it('atualiza só o que veio, e null apaga', () => {
    const repository = new SqliteWatchRepository()
    repository.insert(watch('w1', { lastOutput: 'x' }))
    repository.update('w1', { status: 'met', checks: 2, delivered: true, endedAt: at('10:05:00'), nextCheckAt: null, lastOutput: null, endReason: 'porque' })
    const after = repository.find('w1')!
    assert.strictEqual(after.status, 'met')
    assert.strictEqual(after.checks, 2)
    assert.strictEqual(after.delivered, true)
    assert.deepStrictEqual(after.endedAt, at('10:05:00'))
    assert.strictEqual(after.nextCheckAt, undefined)
    assert.strictEqual(after.lastOutput, undefined)
    assert.strictEqual(after.endReason, 'porque')
    assert.strictEqual(after.label, 'rótulo')
    repository.update('w1', {})
  })

  it('apaga só as encerradas, entregues e antigas', () => {
    const repository = new SqliteWatchRepository()
    repository.insert(watch('ativa'))
    repository.insert(watch('velha', { status: 'met', delivered: true, endedAt: at('09:00:00') }))
    repository.insert(watch('nova', { status: 'met', delivered: true, endedAt: at('10:30:00') }))
    repository.insert(watch('pendente', { status: 'met', delivered: false, endedAt: at('09:00:00') }))
    repository.purge(at('10:00:00'))
    assert.deepStrictEqual(
      repository
        .listBySession('s1')
        .map((item) => item.id)
        .sort(),
      ['ativa', 'nova', 'pendente'],
    )
  })
})
