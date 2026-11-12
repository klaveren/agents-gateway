/** Hora de hoje, "ontem", dia da semana nesta semana, senão a data — como uma caixa de mensagens. */
export function shortTime(iso: string | undefined, now = new Date()): string {
  if (!iso) return ''
  const date = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000

  if (date.getTime() >= startOfToday) return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (date.getTime() >= startOfToday - day) return 'ontem'
  if (date.getTime() >= startOfToday - 6 * day) return date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function fullTime(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''
}

/** Uma duração curta, como o gateway a escreve: "40 s", "2 min", "1 h 30 min", "3 dias". */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return `${Math.round(hours / 24)} dias`
}

/** Há quanto tempo: "agora" no primeiro minuto, depois "há 2 min", "há 1 h 5 min", "há 3 dias". */
export function ago(iso: string | undefined, now = new Date()): string {
  if (!iso) return ''
  const elapsed = now.getTime() - new Date(iso).getTime()
  return elapsed < 60_000 ? 'agora' : `há ${span(elapsed)}`
}

const TOKEN_UNITS = ['k', 'M', 'B', 'T']

/** Tokens em k, M, B (bilhões) e T (trilhões). A unidade sobe quando o arredondamento chegaria a 1000 (nunca "2110.0M"). */
export function tokens(value: number | undefined): string {
  const n = value ?? 0
  if (n < 1_000) return String(n)
  let scaled = n / 1_000
  let unit = 0
  // De B em diante, duas casas: 2.04B e 2.10B não podem virar o mesmo "2.0B".
  const digits = () => (unit >= 2 ? 2 : 1)
  while (unit < TOKEN_UNITS.length - 1 && Number(scaled.toFixed(digits())) >= 1000) {
    scaled /= 1_000
    unit++
  }
  return `${scaled.toFixed(digits())}${TOKEN_UNITS[unit]}`
}

/**
 * ⚖️ O tamanho de um texto como INFORMAÇÃO, nunca trava: quem escreve decide. Caracteres e cerca de quantos tokens
 * (≈ 4 caracteres por token); `when` diz quando pesa ("a cada turno", "quando carregado").
 */
export function sizeHint(text: string, when?: string): string {
  const count = Math.round(text.length / 4)
  const amount = count < 1000 ? String(count) : `${Math.round(count / 100) / 10} mil`.replace('.', ',')
  return `${text.length.toLocaleString('pt-BR')} caracteres · cerca de ${amount} tokens${when ? ` ${when}` : ''}`
}

export function usd(value: number | undefined): string {
  if (value === undefined) return ''
  return value < 0.01 ? `<$0.01` : `$${value.toFixed(2)}`
}

export function initials(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? '')).toUpperCase()
}

export const CLASSIFICATION_COLOR: Record<string, string> = {
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
}

export const CLASSIFICATION_LABEL: Record<string, string> = { green: 'Verde', blue: 'Azul', amber: 'Âmbar', red: 'Vermelho' }

const EFFORT_LABEL: Record<string, string> = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' }

/** O nível de raciocínio como a pessoa lê ("Alto"); um nível desconhecido aparece como veio. */
export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort
}

/**
 * Uma URL para MOSTRAR, sem o que pode ser segredo: some o `usuário:senha@`, o valor de cada parâmetro (`?token=…`)
 * e o fragmento. ⚖️ Fica o que diz ONDE o servidor está (esquema, host, caminho) e quais parâmetros ele leva.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const keys = [...new Set(url.searchParams.keys())]
    return `${url.protocol}//${url.host}${url.pathname}${keys.length ? `?${keys.map((key) => `${key}=…`).join('&')}` : ''}`
  } catch {
    return raw.replace(/[?#].*$/, '').replace(/\/\/[^/@]*@/, '//')
  }
}

/** O tamanho de um arquivo: 820 B, 12,3 KB, 4,1 MB. */
export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`
  return `${(value / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}
