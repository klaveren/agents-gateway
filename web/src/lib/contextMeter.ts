import { tokens } from './format'

export interface IContextMeter {
  /** "45.0k / 200.0k" ou, sem a janela do modelo, "45.0k usados". */
  label: string
  /** O que cabe no donut: "23%", "<1%" ou, sem a janela, "45k". */
  short: string
  /** 0 a 100, só com a janela conhecida. */
  percent?: number
  /** A partir de 80%: a conversa está perto do limite do modelo. */
  warn: boolean
}

export const CONTEXT_WARN_PERCENT = 80

/**
 * O medidor do contexto da conversa: quanto da janela do modelo a última chamada usou. `undefined` quando o
 * provider não informa o uso (Codex, Antigravity) — sem número não há o que mostrar.
 */
export function contextMeter(used: number | undefined, window: number | undefined): IContextMeter | undefined {
  if (used === undefined || used <= 0) return undefined
  if (!window) return { label: `${tokens(used)} usados`, short: tokens(used).replace(/\.0(?=[kM])/, ''), warn: false }
  const percent = Math.min(100, Math.round((used / window) * 100))
  return { label: `${tokens(used)} / ${tokens(window)}`, short: percent === 0 ? '<1%' : `${percent}%`, percent, warn: percent >= CONTEXT_WARN_PERCENT }
}
