/**
 * O cron dos agendamentos na tela: os atalhos e a leitura em português. ⚖️ Só os formatos comuns viram frase; o resto
 * aparece como veio — quem calcula os horários de verdade é o servidor (a próxima execução vem na resposta).
 */
export const SCHEDULE_PRESETS: ReadonlyArray<{ label: string; cron: string }> = [
  { label: 'Todo dia às 8h', cron: '0 8 * * *' },
  { label: 'Seg a sex às 9h', cron: '0 9 * * 1-5' },
  { label: 'A cada hora', cron: '0 * * * *' },
  { label: 'A cada 15 min', cron: '*/15 * * * *' },
  { label: 'Toda segunda às 8h', cron: '0 8 * * 1' },
  { label: 'Todo dia 1º às 9h', cron: '0 9 1 * *' },
]

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

const time = (hour: string, minute: string) => `${Number(hour)}h${minute === '0' || minute === '00' ? '' : String(Number(minute)).padStart(2, '0')}`

/** "seg a sex às 9h", "a cada 15 minutos"… ou `undefined` quando o formato não é um dos comuns. */
export function describeCron(expression: string): string | undefined {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return undefined
  const [minute, hour, day, month, weekday] = parts
  const number = /^\d+$/
  const every = /^\*\/(\d+)$/
  if (every.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `a cada ${every.exec(minute)![1]} minutos`
  if (number.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*')
    return minute === '0' ? 'a cada hora, na hora cheia' : `a cada hora, no minuto ${Number(minute)}`
  if (number.test(minute) && every.test(hour) && day === '*' && month === '*' && weekday === '*') return `a cada ${every.exec(hour)![1]} horas`
  if (!number.test(minute) || !number.test(hour) || month !== '*') return undefined
  const at = `às ${time(hour, minute)}`
  if (day === '*' && weekday === '*') return `todo dia ${at}`
  if (day === '*' && /^[0-7]$/.test(weekday)) return `toda ${WEEKDAYS[Number(weekday)]} ${at}`
  if (day === '*' && /^[0-7]-[0-7]$/.test(weekday)) {
    const [from, to] = weekday.split('-').map(Number)
    return `${WEEKDAY_SHORT[from]} a ${WEEKDAY_SHORT[to]} ${at}`
  }
  if (day === '*' && /^[0-7](,[0-7])+$/.test(weekday))
    return `${weekday
      .split(',')
      .map((item) => WEEKDAY_SHORT[Number(item)])
      .join(', ')} ${at}`
  if (number.test(day) && weekday === '*') return `todo dia ${Number(day)} do mês ${at}`
  return undefined
}

/** Como cada execução aparece no histórico. */
export const RUN_STATUS: Record<'running' | 'ok' | 'error' | 'skipped' | 'missed', { label: string; tone: string }> = {
  running: { label: 'rodando', tone: 'text-amber-300' },
  ok: { label: 'ok', tone: 'text-emerald-300' },
  error: { label: 'erro', tone: 'text-rose-300' },
  skipped: { label: 'pulada', tone: 'text-zinc-400' },
  missed: { label: 'perdida', tone: 'text-zinc-400' },
}
