import assert from 'node:assert'
import { describe, it } from 'node:test'
import { CronError, CronSchedule } from './Cron.Schedule'

describe('CronSchedule', () => {
  const iso = (dates: Array<Date | undefined>) => dates.map((date) => date?.toISOString())

  it('todo dia às 8h em São Paulo (UTC-3)', () => {
    const cron = new CronSchedule('0 8 * * *', 'America/Sao_Paulo')
    assert.deepStrictEqual(iso(cron.upcoming(new Date('2026-10-28T12:00:00Z'), 2)), ['2026-10-29T11:00:00.000Z', '2026-10-30T11:00:00.000Z'])
  })

  it('seg a sex às 9h pula o fim de semana; nomes de dia valem', () => {
    // 2026-10-30 é sexta.
    const cron = new CronSchedule('0 9 * * MON-FRI', 'America/Sao_Paulo')
    assert.deepStrictEqual(iso(cron.upcoming(new Date('2026-10-30T13:00:00Z'), 2)), ['2026-11-02T12:00:00.000Z', '2026-11-03T12:00:00.000Z'])
  })

  it('a cada 15 minutos, e a cada hora no minuto 0', () => {
    assert.deepStrictEqual(iso(new CronSchedule('*/15 * * * *', 'UTC').upcoming(new Date('2026-10-28T10:07:30Z'), 3)), [
      '2026-10-28T10:15:00.000Z',
      '2026-10-28T10:30:00.000Z',
      '2026-10-28T10:45:00.000Z',
    ])
    assert.deepStrictEqual(iso([new CronSchedule('0 * * * *', 'UTC').next(new Date('2026-10-28T10:00:00Z'))]), ['2026-10-28T11:00:00.000Z'])
  })

  it('dia do mês E dia da semana restritos valem como OU; 7 é domingo', () => {
    // Dia 1 ou domingo, às 00:00 UTC — a partir de quarta 2026-10-28: domingo 1º de novembro.
    const cron = new CronSchedule('0 0 1 * 7', 'UTC')
    assert.deepStrictEqual(iso(cron.upcoming(new Date('2026-10-28T00:00:00Z'), 2)), ['2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z'])
  })

  it('⛔ recusa o que não é cron, valor fora da faixa e fuso desconhecido', () => {
    assert.throws(() => new CronSchedule('0 8 * *', 'UTC'), CronError)
    assert.throws(() => new CronSchedule('61 * * * *', 'UTC'), /out of 0-59/)
    assert.throws(() => new CronSchedule('0 8 * * *', 'Lua/Base'), /unknown timezone/)
    assert.throws(() => new CronSchedule('*/0 * * * *', 'UTC'), /bad step/)
  })
})
