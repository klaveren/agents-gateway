import { describe, expect, it } from 'vitest'
import { footprintShares } from './footprint'

describe('footprintShares', () => {
  it('a fatia de cada parte medida; a não medida fica com 0 e cinza', () => {
    const shares = footprintShares([
      { key: 'soul', label: 'Soul', tokens: 100 },
      { key: 'mcp:x', label: 'MCP x', tokens: 300 },
      { key: 'sdk', label: 'SDK', tokens: null },
    ])
    expect(shares.map((share) => share.share)).toEqual([25, 75, 0])
    expect(shares[2].color).toBe('bg-zinc-700')
    expect(shares[0].color).not.toBe(shares[1].color)
  })
})
