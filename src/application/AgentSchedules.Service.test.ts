import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InvalidScheduleError } from '@domain/errors/Domain.Error'
import { SqliteAgentScheduleRepository } from '@infra/persistence/Sqlite.AgentScheduleRepository'
import { AgentSchedulesService } from './AgentSchedules.Service'

describe('AgentSchedulesService', () => {
  const now = new Date('2026-10-28T12:00:00Z')
  const agents: Record<string, { id: string; projectId?: string }> = { global: { id: 'global' }, dev: { id: 'dev', projectId: 'xpto' } }
  const build = () =>
    new AgentSchedulesService(
      new SqliteAgentScheduleRepository(),
      (id) => agents[id],
      (id) => id === 'xpto',
      () => now,
    )
  const by = { userId: 'u_root', label: 'root@x.test' }
  const fields = (error: unknown) => (error as InvalidScheduleError).issues.map((issue) => issue.field)

  it('cria em nome de quem pede, no fuso padrão, "em dia" (nada antes de existir conta como perdido); a próxima execução', () => {
    const service = build()
    const schedule = service.create('global', { name: 'resumo-diario', cron: '0 8 * * *', prompt: '/resumir hoje', projectId: 'xpto' }, by)
    assert.deepStrictEqual(
      [schedule.runAs, schedule.timezone, schedule.session, schedule.projectId, schedule.lastScheduledFor],
      ['u_root', 'America/Sao_Paulo', 'new', 'xpto', now],
    )
    assert.strictEqual(service.nextRun(schedule)?.toISOString(), '2026-10-29T11:00:00.000Z')
  })

  it('⛔ recusa: nome, cron, fuso, intervalo abaixo de 5 minutos, texto vazio, projeto em agente de projeto e agente que não existe', () => {
    const service = build()
    assert.throws(
      () => service.create('global', { name: 'X', cron: '0 8 * *', prompt: '' }, by),
      (error) => fields(error).join() === 'name,prompt,cron',
    )
    assert.throws(() => service.create('global', { name: 'ok', cron: '* * * * *', prompt: 'x' }, by), /more often than every 5 minutes/)
    assert.throws(() => service.create('global', { name: 'ok', cron: '0,1 8 * * *', prompt: 'x' }, by), /more often/)
    assert.throws(
      () => service.create('global', { name: 'ok', cron: '0 8 * * *', timezone: 'Lua/Base', prompt: 'x' }, by),
      (error) => fields(error).join() === 'timezone',
    )
    assert.throws(() => service.create('dev', { name: 'ok', cron: '0 8 * * *', prompt: 'x', projectId: 'xpto' }, by), /already runs in its own project/)
    assert.throws(() => service.create('sumiu', { name: 'ok', cron: '0 8 * * *', prompt: 'x' }, by), /no such agent/)
  })

  it('⛔ falhas seguidas pausam no limite, com o motivo; um sucesso zera; religar limpa a pausa', () => {
    const service = build()
    const schedule = service.create('global', { name: 'quebrado', cron: '0 * * * *', prompt: 'x' }, by)
    for (let index = 0; index < 4; index += 1)
      service.finishRun(schedule, service.recordRun(schedule, { trigger: 'cron', scheduledFor: now, status: 'running' }).id, { error: 'boom' })
    service.finishRun(schedule, service.recordRun(schedule, { trigger: 'cron', scheduledFor: now, status: 'running' }).id, {})
    assert.strictEqual(service.get('global', 'quebrado').failures, 0)
    for (let index = 0; index < 5; index += 1)
      service.finishRun(schedule, service.recordRun(schedule, { trigger: 'cron', scheduledFor: now, status: 'running' }).id, { error: 'boom' })
    const paused = service.get('global', 'quebrado')
    assert.deepStrictEqual([paused.enabled, paused.failures], [false, 5])
    assert.match(paused.pausedReason!, /5 falhas seguidas: boom/)
    assert.strictEqual(service.nextRun(paused), undefined)

    const resumed = service.update('global', 'quebrado', { enabled: true }, 'root')
    assert.deepStrictEqual([resumed.enabled, resumed.failures, resumed.pausedReason], [true, 0, undefined])
  })

  it('o histórico guarda o status e a conversa; trocar o modo larga a conversa contínua', () => {
    const service = build()
    const schedule = service.create('global', { name: 'continuo', cron: '0 * * * *', prompt: 'x', session: 'continuous' }, by)
    service.setSession(schedule, 'conv-1')
    const run = service.recordRun(schedule, { trigger: 'manual', scheduledFor: now, status: 'running' })
    service.finishRun(schedule, run.id, { sessionId: 'conv-1' })
    assert.deepStrictEqual(
      service.runs('global', 'continuo').map((item) => [item.trigger, item.status, item.sessionId]),
      [['manual', 'ok', 'conv-1']],
    )
    assert.strictEqual(service.update('global', 'continuo', { session: 'new' }, 'root').sessionId, undefined)
  })
})
