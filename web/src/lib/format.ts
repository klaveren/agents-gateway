import type { TProvider } from './types'

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

export const PROVIDER_LABEL: Record<TProvider, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  google: 'Gemini',
  'claude-sub': 'Claude (assinatura)',
  codex: 'ChatGPT (assinatura)',
  antigravity: 'Antigravity (assinatura)',
}

/** Cor de cada provider: o avatar diz de quem é a conversa antes de ler o nome. */
export const PROVIDER_COLOR: Record<TProvider, string> = {
  claude: 'bg-claude',
  openai: 'bg-openai',
  google: 'bg-google',
  'claude-sub': 'bg-claude',
  codex: 'bg-openai',
  antigravity: 'bg-google',
}

export const CLASSIFICATION_COLOR: Record<string, string> = {
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  amber: 'bg-amber-500',
  red: 'bg-rose-500',
}

export const CLASSIFICATION_LABEL: Record<string, string> = { green: 'Verde', blue: 'Azul', amber: 'Âmbar', red: 'Vermelho' }

/** O nome de um provider pelo id: os oficiais têm rótulo próprio; um compatível aparece pelo id. */
export function providerLabel(id: string, names: ReadonlyMap<string, string> = new Map()): string {
  return names.get(id) ?? PROVIDER_LABEL[id as TProvider] ?? id
}

/** A cor do avatar: a do oficial, ou neutra para um compatível (que pode servir modelos de todo mundo). */
export function providerColor(id: string): string {
  return PROVIDER_COLOR[id as TProvider] ?? 'bg-zinc-600'
}
