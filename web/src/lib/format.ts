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

export function tokens(value: number | undefined): string {
  const n = value ?? 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
