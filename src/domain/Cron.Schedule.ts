/**
 * Uma expressão CRON de 5 campos (minuto hora dia mês dia-da-semana) num fuso IANA, e o próximo horário dela.
 *
 * ⚖️ SEM DEPENDÊNCIA: o que o agendamento precisa é pouco (listas, faixas, passos, nomes de mês e de dia, o fuso), e o
 * fuso vem do `Intl` do próprio Node. Dia do mês E dia da semana restritos valem como OU, como no cron clássico.
 */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] },
  { name: 'weekday', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
] as const

interface ILocal {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number
}

export class CronError extends Error {}

export class CronSchedule {
  private readonly sets: Array<Set<number>>
  /** Dia do mês e dia da semana restritos (não `*`): os dois valem como OU. */
  private readonly dayRestricted: boolean
  private readonly weekdayRestricted: boolean
  private readonly format: Intl.DateTimeFormat

  constructor(
    readonly expression: string,
    readonly timezone: string,
  ) {
    const parts = expression.trim().split(/\s+/)
    if (parts.length !== 5) throw new CronError('use 5 fields: minute hour day month weekday')
    this.sets = parts.map((part, index) => parseField(part, FIELDS[index]))
    // 7 também é domingo.
    if (this.sets[4].has(7)) this.sets[4].add(0)
    this.dayRestricted = parts[2] !== '*'
    this.weekdayRestricted = parts[4] !== '*'
    try {
      this.format = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
      })
    } catch {
      throw new CronError(`unknown timezone: ${timezone}`)
    }
  }

  /** O próximo horário DEPOIS de `after` (no minuto cheio). `undefined` se não houver nos próximos ~5 anos. */
  next(after: Date): Date | undefined {
    let time = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000
    const limit = time + 5 * 366 * 86_400_000
    while (time < limit) {
      const local = this.local(new Date(time))
      if (!this.sets[3].has(local.month) || !this.dayMatches(local)) {
        // Para o começo do próximo dia local (o fuso de verão se acerta na volta seguinte).
        time += ((23 - local.hour) * 60 + (60 - local.minute)) * 60_000
        continue
      }
      if (!this.sets[1].has(local.hour)) {
        time += (60 - local.minute) * 60_000
        continue
      }
      if (!this.sets[0].has(local.minute)) {
        time += 60_000
        continue
      }
      return new Date(time)
    }
    return undefined
  }

  /** Os próximos `count` horários a partir de `after`. */
  upcoming(after: Date, count: number): Date[] {
    const found: Date[] = []
    let cursor = after
    while (found.length < count) {
      const next = this.next(cursor)
      if (!next) break
      found.push(next)
      cursor = next
    }
    return found
  }

  private dayMatches(local: ILocal): boolean {
    const day = this.sets[2].has(local.day)
    const weekday = this.sets[4].has(local.weekday)
    if (this.dayRestricted && this.weekdayRestricted) return day || weekday
    return day && weekday
  }

  private local(date: Date): ILocal {
    const parts = Object.fromEntries(this.format.formatToParts(date).map((part) => [part.type, part.value]))
    return {
      minute: Number(parts.minute),
      hour: Number(parts.hour),
      day: Number(parts.day),
      month: Number(parts.month),
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(String(parts.weekday)),
    }
  }
}

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>()
  const value = (raw: string): number => {
    const name = 'names' in field ? field.names.indexOf(raw.toUpperCase() as never) : -1
    const number = name >= 0 ? name + (field.name === 'month' ? 1 : 0) : Number(raw)
    if (!Number.isInteger(number) || number < field.min || number > field.max) throw new CronError(`${field.name}: ${raw} is out of ${field.min}-${field.max}`)
    return number
  }
  for (const piece of text.split(',')) {
    const [range, stepText] = piece.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new CronError(`${field.name}: bad step in ${piece}`)
    let from: number
    let to: number
    if (range === '*') {
      from = field.min
      to = field.name === 'weekday' ? 6 : field.max
    } else if (range.includes('-')) {
      const [start, end] = range.split('-')
      from = value(start)
      to = value(end)
      if (from > to) throw new CronError(`${field.name}: ${range} goes backwards`)
    } else {
      from = value(range)
      to = stepText === undefined ? from : field.name === 'weekday' ? 6 : field.max
    }
    for (let current = from; current <= to; current += step) values.add(current)
  }
  return values
}
