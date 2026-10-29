import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SqliteAgentScheduleRepository } from '@infra/persistence/Sqlite.AgentScheduleRepository'
import { AgentSchedulesService } from './AgentSchedules.Service'
import { ScheduleRunner } from './Schedule.Runner'

describe('ScheduleRunner', () => {
  const setup = (start: string) => {
    let clock = new Date(start)
    const service = new AgentSchedulesService(
      new SqliteAgentScheduleRepository(),
      (id) => ({ id }),
      () => true,
      () => clock,
    )
    const executed: string[] = []
    let release = () => undefined as void
    let hold = false
    const runner = new ScheduleRunner(
      service,
      async (schedule) => {
        executed.push(schedule.name)
        if (hold) await new Promise<void>((resolve) => (release = resolve))
        return { sessionId: `conv-${executed.length}` }
      },
      () => clock,
    )
    const schedule = service.create('agente', { name: 'hora-cheia', cron: '0 * * * *', timezone: 'UTC', prompt: '/resumir' }, { userId: 'u', label: 'u' })
    return {
      service,
      runner,
      schedule,
      executed,
      at: (iso: string) => (clock = new Date(iso)),
      holding: () => (hold = true),
      release: () => release(),
    }
  }
  const statuses = (service: AgentSchedulesService) => service.runs('agente', 'hora-cheia').map((run) => run.status)

  it('dispara o horário que venceu, uma vez só, e grava o resultado', async () => {
    const { service, runner, executed, at } = setup('2026-10-28T10:30:00Z')
    assert.deepStrictEqual(await runner.tick(), [])
    at('2026-10-28T11:00:10Z')
    await Promise.all(await runner.tick())
    await Promise.all(await runner.tick())
    assert.deepStrictEqual(executed, ['hora-cheia'])
    assert.deepStrictEqual(statuses(service), ['ok'])
  })

  it('⛔ não sobrepõe: com a anterior rodando, a nova é registrada como pulada', async () => {
    const { service, runner, executed, at, holding, release } = setup('2026-10-28T10:30:00Z')
    holding()
    at('2026-10-28T11:00:05Z')
    const first = await runner.tick()
    at('2026-10-28T11:00:30Z')
    await runner.runNow(service.get('agente', 'hora-cheia'))
    release()
    await Promise.all(first)
    assert.deepStrictEqual(executed, ['hora-cheia'])
    assert.deepStrictEqual(statuses(service).sort(), ['ok', 'skipped'])
  })

  it('⚖️ gateway fora do ar no horário: registra as perdidas e não roda; o próximo horário roda normal', async () => {
    const { service, runner, executed, at } = setup('2026-10-28T10:30:00Z')
    // Voltou às 14:10: 11h, 12h, 13h e 14h passaram há mais de 2 minutos.
    at('2026-10-28T14:10:00Z')
    await Promise.all(await runner.tick())
    assert.deepStrictEqual(executed, [])
    const [missed] = service.runs('agente', 'hora-cheia')
    assert.deepStrictEqual([missed.status, missed.scheduledFor.toISOString()], ['missed', '2026-10-28T14:00:00.000Z'])
    assert.match(missed.error!, /^4 execução\(ões\) perdida\(s\)/)

    at('2026-10-28T15:00:20Z')
    await Promise.all(await runner.tick())
    assert.deepStrictEqual(executed, ['hora-cheia'])
  })

  it('"rodar agora" não mexe no relógio; pausado não dispara', async () => {
    const { service, runner, executed, at } = setup('2026-10-28T10:30:00Z')
    await runner.runNow(service.get('agente', 'hora-cheia'))
    assert.deepStrictEqual(service.runs('agente', 'hora-cheia')[0].trigger, 'manual')
    service.update('agente', 'hora-cheia', { enabled: false }, 'root')
    at('2026-10-28T11:00:10Z')
    assert.deepStrictEqual(await runner.tick(), [])
    assert.deepStrictEqual(executed, ['hora-cheia'])
  })
})
