import { describe, expect, it } from 'vitest'
import { usageSegments } from './usageSegments'

describe('usageSegments', () => {
  const day = (usage: Partial<Record<string, number>>) =>
    ({ usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, ...usage }, turns: 1 }) as never

  it('o cache é parcela da entrada: lido + gravado + nova = entrada; a saída leva o raciocínio', () => {
    expect(usageSegments(day({ inputTokens: 1000, cacheReadTokens: 700, cacheWriteTokens: 200, outputTokens: 50, reasoningTokens: 10 }))).toEqual({
      cacheRead: 700,
      cacheWrite: 200,
      fresh: 100,
      output: 60,
    })
  })

  it('cache maior que a entrada (dado incoerente) não deixa parte negativa', () => {
    expect(usageSegments(day({ inputTokens: 100, cacheReadTokens: 150, cacheWriteTokens: 20 }))).toEqual({ cacheRead: 100, cacheWrite: 0, fresh: 0, output: 0 })
  })
})
