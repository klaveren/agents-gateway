import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IWatchCheck } from '@domain/models/Watch.Model'
import { SqliteWatchRepository } from '@infra/persistence/Sqlite.WatchRepository'
import { WatchRunner } from './Watch.Runner'
import { WatchService } from './Watch.Service'

const command = { label: 'servidor voltar', command: 'test -f pronto', everySeconds: 60, deadlineMinutes: 10, then: 'avisar' }

const setup = (repository = new SqliteWatchRepository(), start = '2026-01-01T10:00:00Z') => {
  let clock = new Date(start)
  let draining = false
  let hold = false
  let broken = false
  let next = 0
  const releases: Array<() => void> = []
  const state = { checked: 0, verdict: 'unmet' as IWatchCheck['verdict'] }
  const delivered: string[] = []
  const service = new WatchService({
    repository,
    conversation: async () => {
      if (broken) throw new Error('banco fora')
      return { agentId: 'a', ownerId: 'u', delegated: false, archived: false }
    },
    ownerActive: () => true,
    now: () => clock,
    newId: () => `w-${start}-${++next}`,
  })
  service.useCheck(async () => {
    state.checked += 1
    if (hold) await new Promise<void>((resolve) => releases.push(resolve))
    return { verdict: state.verdict, output: '' }
  })
  service.useDelivery(async (_watch, text) => {
    delivered.push(text)
    return 'turn'
  })
  const runner = new WatchRunner(
    service,
    () => clock,
    () => draining,
    2,
  )
  return {
    service,
    runner,
    repository,
    state,
    delivered,
    advance: (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000)),
    drain: (on: boolean) => (draining = on),
    holding: (on: boolean) => (hold = on),
    breaking: () => (broken = true),
    release: () => releases.splice(0).forEach((resolve) => resolve()),
  }
}

describe('WatchRunner', () => {
  it('confere o que venceu e dispara quando a condição bate', async () => {
    const { service, runner, state, delivered, advance } = setup()
    await service.startCommand('s1', command)
    assert.strictEqual(runner.tick().length, 0)
    advance(60)
    await Promise.all(runner.tick())
    assert.strictEqual(state.checked, 2)
    state.verdict = 'met'
    advance(60)
    await Promise.all(runner.tick())
    assert.strictEqual(delivered.length, 1)
    advance(600)
    assert.strictEqual(runner.tick().length, 0)
  })

  it('drenando, nada roda; depois do dreno, dispara atrasado', async () => {
    const { service, runner, delivered, advance, drain } = setup()
    await service.wake('s1', { label: 'ticket', afterMinutes: 10, then: 'conferir' })
    drain(true)
    advance(30 * 60)
    assert.strictEqual(runner.tick().length, 0)
    assert.strictEqual(delivered.length, 0)
    drain(false)
    await Promise.all(runner.tick())
    assert.ok(delivered[0].includes('20 min de atraso'))
  })

  it('não confere a mesma vigia duas vezes ao mesmo tempo, e respeita o teto de simultâneas', async () => {
    const { service, runner, state, advance, holding, release } = setup()
    await service.startCommand('s1', command)
    await service.startCommand('s1', command)
    await service.startCommand('s1', command)
    state.checked = 0
    holding(true)
    advance(60)
    const first = runner.tick()
    assert.strictEqual(first.length, 2)
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(runner.tick().length, 0)
    assert.strictEqual(state.checked, 2)
    release()
    await Promise.all(first)
    holding(false)
    await Promise.all(runner.tick())
    assert.strictEqual(state.checked, 3)
  })

  it('sobrevive ao reinício: o processo novo continua a vigia e dispara a que venceu fora do ar', async () => {
    const repository = new SqliteWatchRepository()
    const before = setup(repository)
    await before.service.startCommand('s1', { ...command, deadlineMinutes: 60 })
    await before.service.wake('s1', { label: 'ticket', afterMinutes: 5, then: 'conferir' })

    const after = setup(repository, '2026-01-01T10:20:00Z')
    after.state.verdict = 'met'
    await Promise.all(after.runner.tick())
    assert.strictEqual(after.delivered.length, 2)
    assert.ok(after.delivered.some((text) => text.includes('chegou a hora de "ticket"') && text.includes('15 min de atraso')))
    assert.ok(after.delivered.some((text) => text.includes('a vigia "servidor voltar"') && text.includes('disparou')))
  })

  it('a falha de uma vigia não derruba o ciclo', async () => {
    const { service, runner, state, advance, breaking } = setup()
    await service.startCommand('s1', command)
    breaking()
    advance(60)
    const original = console.error
    const logged: string[] = []
    console.error = (text: string) => void logged.push(text)
    try {
      await Promise.all(runner.tick())
    } finally {
      console.error = original
    }
    assert.ok(logged[0].includes('banco fora'))
    assert.strictEqual(state.checked, 1)
  })
})
