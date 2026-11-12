import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IWatch, IWatchCheck, WATCH_LIMITS } from '@domain/models/Watch.Model'
import { SqliteWatchRepository } from '@infra/persistence/Sqlite.WatchRepository'
import { IWatchConversation, TWatchDelivery, WatchService } from './Watch.Service'

const START = '2026-01-01T10:00:00Z'
const command = { label: 'servidor voltar', command: 'test -f pronto', everySeconds: 60, deadlineMinutes: 10, then: 'avisar' }

const setup = (options: { maxActive?: number } = {}) => {
  let clock = new Date(START)
  let next = 0
  const repository = new SqliteWatchRepository()
  const conversations = new Map<string, IWatchConversation>([
    ['s1', { agentId: 'a', ownerId: 'u', delegated: false, archived: false }],
    ['filha', { agentId: 'sub', ownerId: 'u', delegated: true, archived: false }],
    ['sem-dono', { agentId: 'a', delegated: false, archived: false }],
  ])
  const owners = new Set(['u'])
  const checks: IWatchCheck[] = []
  const delivered: Array<{ id: string; text: string }> = []
  const state = { delivery: 'turn' as TWatchDelivery | Error, checked: 0 }
  const service = new WatchService({
    repository,
    conversation: async (id) => conversations.get(id),
    ownerActive: (id) => owners.has(id),
    now: () => clock,
    newId: () => `w-${++next}`,
    ...(options.maxActive ? { maxActive: () => options.maxActive! } : {}),
  })
  service.useCheck(async () => {
    state.checked += 1
    return checks.shift() ?? { verdict: 'unmet', output: 'Exit code 1: ' }
  })
  service.useDelivery(async (watch, text) => {
    if (state.delivery instanceof Error) throw state.delivery
    delivered.push({ id: watch.id, text })
    return state.delivery
  })
  const advance = (seconds: number) => (clock = new Date(clock.getTime() + seconds * 1000))
  /** Um ciclo do relógio, em série. */
  const cycle = async () => {
    for (const watch of service.due()) await service.process(watch)
  }
  const armed = async (input = command, sessionId = 's1'): Promise<IWatch> => {
    const result = await service.startCommand(sessionId, input)
    assert.ok('watch' in result, JSON.stringify(result))
    return result.watch
  }
  return { service, repository, conversations, owners, checks, delivered, state, advance, cycle, armed }
}

describe('WatchService', () => {
  it('arma depois de conferir uma vez, e agenda a próxima conferência', async () => {
    const { repository, armed, state } = setup()
    const watch = await armed()
    assert.strictEqual(state.checked, 1)
    assert.strictEqual(watch.checks, 1)
    assert.strictEqual(watch.runAs, 'u')
    assert.strictEqual(watch.agentId, 'a')
    assert.deepStrictEqual(watch.nextCheckAt, new Date('2026-01-01T10:01:00Z'))
    assert.deepStrictEqual(watch.deadlineAt, new Date('2026-01-01T10:10:00Z'))
    assert.deepStrictEqual(repository.find(watch.id), watch)
  })

  it('o que já aconteceu não arma nada; o comando recusado e o lento voltam como recusa', async () => {
    const { service, repository, checks } = setup()
    checks.push({ verdict: 'met', output: 'já está lá' })
    assert.deepStrictEqual(await service.startCommand('s1', command), { already: 'já está lá' })
    checks.push({ verdict: 'refused', output: 'Not permitted: rm' })
    assert.deepStrictEqual(await service.startCommand('s1', command), { refused: 'Not permitted: rm' })
    checks.push({ verdict: 'timeout', output: 'Tempo esgotado (30s)' })
    const slow = await service.startCommand('s1', command)
    assert.ok('refused' in slow && slow.refused.includes('passou de 30 s'))
    assert.strictEqual(repository.countActive(), 0)
  })

  it('recusa em conversa de delegação, sem dono, com o dono desativado e fora de conversa', async () => {
    const { service, owners, state } = setup()
    const child = await service.startCommand('filha', command)
    assert.ok('refused' in child && child.refused.includes('espere dentro do turno ou devolva à conversa-mãe'))
    const wake = await service.wake('filha', { label: 'x', afterMinutes: 10, then: 't' })
    assert.ok('refused' in wake && wake.refused.includes('delegação'))
    const orphan = await service.startCommand('sem-dono', command)
    assert.ok('refused' in orphan && orphan.refused.includes('conta dona'))
    assert.ok('refused' in (await service.startCommand('nenhuma', command)))
    owners.delete('u')
    assert.ok('refused' in (await service.wake('s1', { label: 'x', afterMinutes: 10, then: 't' })))
    assert.strictEqual(state.checked, 0)
  })

  it('respeita o teto por conversa e o do gateway', async () => {
    const perSession = setup()
    for (let i = 0; i < WATCH_LIMITS.perSession; i += 1) await perSession.armed()
    const sixth = await perSession.service.startCommand('s1', command)
    assert.ok('refused' in sixth && sixth.refused.includes('já tem 5 vigias ativas'))

    const global = setup({ maxActive: 1 })
    global.conversations.set('s2', { agentId: 'a', ownerId: 'u', delegated: false, archived: false })
    await global.armed()
    const other = await global.service.wake('s2', { label: 'x', afterMinutes: 10, then: 't' })
    assert.ok('refused' in other && other.refused.includes('teto de 1 vigias'))
  })

  it('a condição bate: encerra e entrega o aviso com a saída e o que o agente anotou', async () => {
    const { repository, checks, delivered, advance, cycle, armed, state } = setup()
    const watch = await armed()
    advance(30)
    await cycle()
    assert.strictEqual(state.checked, 1)
    advance(30)
    await cycle()
    assert.strictEqual(repository.find(watch.id)!.checks, 2)
    checks.push({ verdict: 'met', output: 'pronto' })
    advance(60)
    await cycle()
    const after = repository.find(watch.id)!
    assert.strictEqual(after.status, 'met')
    assert.strictEqual(after.delivered, true)
    assert.strictEqual(delivered.length, 1)
    assert.ok(delivered[0].text.includes('disparou') && delivered[0].text.includes('pronto') && delivered[0].text.includes('avisar'))
    advance(600)
    await cycle()
    assert.strictEqual(delivered.length, 1)
  })

  it('o prazo passa: a última conferência cai no prazo e só então expira', async () => {
    const { repository, delivered, advance, cycle, armed } = setup()
    const watch = await armed({ ...command, everySeconds: 240, deadlineMinutes: 10 })
    advance(240)
    await cycle()
    advance(240)
    await cycle()
    assert.deepStrictEqual(repository.find(watch.id)!.nextCheckAt, new Date('2026-01-01T10:10:00Z'))
    advance(120)
    await cycle()
    const after = repository.find(watch.id)!
    assert.strictEqual(after.status, 'expired')
    assert.strictEqual(after.checks, 4)
    assert.ok(delivered[0].text.includes('SEM a condição acontecer'))
  })

  it('cinco conferências seguidas que não rodam encerram como falha; uma que roda zera a conta', async () => {
    const { repository, checks, delivered, advance, cycle, armed } = setup()
    const watch = await armed({ ...command, deadlineMinutes: 60 })
    for (let i = 0; i < 4; i += 1) checks.push({ verdict: 'refused', output: 'Not permitted' })
    checks.push({ verdict: 'unmet', output: 'Exit code 1: ' })
    for (let i = 0; i < 5; i += 1) {
      advance(60)
      await cycle()
    }
    assert.strictEqual(repository.find(watch.id)!.status, 'active')
    assert.strictEqual(repository.find(watch.id)!.failures, 0)
    for (let i = 0; i < 4; i += 1) checks.push({ verdict: 'timeout', output: 'Tempo esgotado' })
    checks.push({ verdict: 'refused', output: 'Not permitted' })
    for (let i = 0; i < 5; i += 1) {
      advance(60)
      await cycle()
    }
    const after = repository.find(watch.id)!
    assert.strictEqual(after.status, 'failed')
    assert.ok(delivered[0].text.includes('não rodou 5 vezes seguidas'))
  })

  it('o wake_me acorda na hora; vencido com o gateway fora, dispara atrasado e diz', async () => {
    const onTime = setup()
    const first = await onTime.service.wake('s1', { label: 'ticket', afterMinutes: 30, then: 'conferir o ticket' })
    assert.ok('watch' in first)
    onTime.advance(29 * 60)
    await onTime.cycle()
    assert.strictEqual(onTime.delivered.length, 0)
    onTime.advance(60)
    await onTime.cycle()
    assert.ok(onTime.delivered[0].text.includes('chegou a hora de "ticket"') && !onTime.delivered[0].text.includes('atraso'))
    assert.strictEqual(onTime.state.checked, 0)

    const late = setup()
    await late.service.wake('s1', { label: 'ticket', afterMinutes: 30, then: 'conferir' })
    late.advance(90 * 60)
    await late.cycle()
    assert.ok(late.delivered[0].text.includes('1 h de atraso'))
  })

  it('a entrega que falha fica pendente e é tentada de novo, com espera crescente', async () => {
    const { repository, checks, delivered, advance, cycle, armed, state } = setup()
    const watch = await armed()
    state.delivery = new Error('conversa ocupada')
    checks.push({ verdict: 'met', output: 'ok' })
    advance(60)
    await cycle()
    let after = repository.find(watch.id)!
    assert.strictEqual(after.status, 'met')
    assert.strictEqual(after.delivered, false)
    assert.strictEqual(after.deliveryAttempts, 1)
    assert.deepStrictEqual(after.nextCheckAt, new Date('2026-01-01T10:01:30Z'))
    advance(10)
    await cycle()
    assert.strictEqual(repository.find(watch.id)!.deliveryAttempts, 1)
    advance(20)
    await cycle()
    after = repository.find(watch.id)!
    assert.strictEqual(after.deliveryAttempts, 2)
    assert.deepStrictEqual(after.nextCheckAt, new Date('2026-01-01T10:02:30Z'))
    state.delivery = 'queued'
    advance(60)
    await cycle()
    assert.strictEqual(repository.find(watch.id)!.delivered, true)
    assert.strictEqual(delivered.length, 1)
    assert.strictEqual(state.checked, 2)
  })

  it('desiste da entrega depois do teto de tentativas', async () => {
    const { repository, checks, advance, cycle, armed, state } = setup()
    const watch = await armed()
    state.delivery = new Error('fora')
    checks.push({ verdict: 'met', output: 'ok' })
    for (let i = 0; i < WATCH_LIMITS.maxDeliveryAttempts + 2; i += 1) {
      advance(600)
      await cycle()
    }
    const after = repository.find(watch.id)!
    assert.strictEqual(after.delivered, true)
    assert.strictEqual(after.deliveryAttempts, WATCH_LIMITS.maxDeliveryAttempts)
    assert.ok(after.endReason?.includes('o aviso não entrou na conversa: fora'))
  })

  it('conversa arquivada ou apagada e dono desativado encerram sem turno', async () => {
    const archived = setup()
    const a = await archived.armed()
    archived.conversations.set('s1', { agentId: 'a', ownerId: 'u', delegated: false, archived: true })
    archived.advance(60)
    await archived.cycle()
    assert.strictEqual(archived.repository.find(a.id)!.status, 'cancelled')
    assert.strictEqual(archived.repository.find(a.id)!.delivered, true)
    assert.strictEqual(archived.state.checked, 1)

    const gone = setup()
    const g = await gone.armed()
    gone.conversations.delete('s1')
    gone.advance(60)
    await gone.cycle()
    assert.strictEqual(gone.repository.find(g.id)!.endReason, 'a conversa foi apagada')

    const disabled = setup()
    const d = await disabled.armed()
    disabled.owners.delete('u')
    disabled.advance(60)
    await disabled.cycle()
    assert.strictEqual(disabled.repository.find(d.id)!.status, 'failed')
    assert.strictEqual(disabled.delivered.length, 0)

    const atDelivery = setup()
    const n = await atDelivery.armed()
    atDelivery.state.delivery = 'no-owner'
    atDelivery.checks.push({ verdict: 'met', output: 'ok' })
    atDelivery.advance(60)
    await atDelivery.cycle()
    assert.strictEqual(atDelivery.repository.find(n.id)!.status, 'failed')
    assert.strictEqual(atDelivery.repository.find(n.id)!.delivered, true)
  })

  it('cancelar: só a ativa desta conversa; apagar a conversa para tudo', async () => {
    const { service, repository, conversations, checks, advance, cycle, armed, state, delivered } = setup()
    conversations.set('s2', { agentId: 'a', ownerId: 'u', delegated: false, archived: false })
    const watch = await armed()
    assert.strictEqual(service.stop('s2', watch.id), undefined)
    assert.strictEqual(service.stop('s1', watch.id)?.status, 'cancelled')
    assert.strictEqual(service.stop('s1', watch.id), undefined)
    advance(600)
    await cycle()
    assert.strictEqual(state.checked, 1)

    const other = await armed(command, 's2')
    const pending = await armed(command, 's2')
    state.delivery = new Error('fora')
    checks.push({ verdict: 'unmet', output: '' }, { verdict: 'met', output: 'ok' })
    advance(60)
    await cycle()
    assert.strictEqual(repository.find(pending.id)!.delivered, false)
    service.cancelSession('s2')
    assert.strictEqual(repository.find(other.id)!.status, 'cancelled')
    assert.strictEqual(repository.find(pending.id)!.delivered, true)
    assert.strictEqual(service.due(new Date('2027-01-01T00:00:00Z')).length, 0)
    assert.strictEqual(delivered.length, 0)
    assert.strictEqual(service.list('s2').length, 2)
  })

  it('a vigia cancelada durante a conferência não dispara', async () => {
    const { service, repository, delivered, advance, armed } = setup()
    const watch = await armed()
    service.useCheck(async () => {
      service.stop('s1', watch.id)
      return { verdict: 'met', output: 'ok' }
    })
    advance(60)
    for (const due of service.due()) await service.process(due)
    assert.strictEqual(repository.find(watch.id)!.status, 'cancelled')
    assert.strictEqual(delivered.length, 0)
  })

  it('a conferência que lança conta como conferência que não rodou', async () => {
    const { service, repository, advance, armed } = setup()
    const watch = await armed()
    service.useCheck(async () => {
      throw new Error('a pasta sumiu')
    })
    advance(60)
    for (const due of service.due()) await service.process(due)
    const after = repository.find(watch.id)!
    assert.strictEqual(after.failures, 1)
    assert.ok(after.lastOutput?.includes('a pasta sumiu'))
  })
})
