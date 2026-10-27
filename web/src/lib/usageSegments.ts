import type { IUsageFigure } from './types'

export type TUsageSegment = 'cacheRead' | 'cacheWrite' | 'fresh' | 'output'

/**
 * As partes de um dia, de baixo para cima: o cache lido, o cache gravado e a entrada nova — que JUNTOS são a entrada
 * (o cache é parcela dela, não soma) — e a saída (com o raciocínio).
 * ⚖️ Separados porque o preço é outro: o cache lido custa uma fração da entrada, e o gravado, mais.
 */
export const USAGE_SEGMENTS: ReadonlyArray<{ key: TUsageSegment; label: string; color: string }> = [
  { key: 'cacheRead', label: 'Cache lido', color: 'var(--series-cache-read)' },
  { key: 'cacheWrite', label: 'Cache gravado', color: 'var(--series-cache-write)' },
  { key: 'fresh', label: 'Entrada nova', color: 'var(--series-1)' },
  { key: 'output', label: 'Saída (com raciocínio)', color: 'var(--series-2)' },
]

export function usageSegments(day: IUsageFigure): Record<TUsageSegment, number> {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens } = day.usage
  const cacheRead = Math.min(cacheReadTokens ?? 0, inputTokens)
  const cacheWrite = Math.min(cacheWriteTokens ?? 0, inputTokens - cacheRead)
  return { cacheRead, cacheWrite, fresh: inputTokens - cacheRead - cacheWrite, output: outputTokens + reasoningTokens }
}
