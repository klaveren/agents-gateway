import { describe, expect, it } from 'vitest'
import { describeCron, SCHEDULE_PRESETS } from './cron'

describe('describeCron', () => {
  it('os formatos comuns viram frase', () => {
    expect(describeCron('0 8 * * *')).toBe('todo dia às 8h')
    expect(describeCron('30 9 * * 1-5')).toBe('seg a sex às 9h30')
    expect(describeCron('*/15 * * * *')).toBe('a cada 15 minutos')
    expect(describeCron('0 * * * *')).toBe('a cada hora, na hora cheia')
    expect(describeCron('0 */2 * * *')).toBe('a cada 2 horas')
    expect(describeCron('0 8 * * 1')).toBe('toda segunda às 8h')
    expect(describeCron('0 8 * * 1,3,5')).toBe('seg, qua, sex às 8h')
    expect(describeCron('0 9 1 * *')).toBe('todo dia 1 do mês às 9h')
  })

  it('o que não é comum fica sem frase; todo atalho tem frase', () => {
    expect(describeCron('0 8 * 1 *')).toBeUndefined()
    expect(describeCron('isto não')).toBeUndefined()
    for (const preset of SCHEDULE_PRESETS) expect(describeCron(preset.cron)).toBeTruthy()
  })
})
