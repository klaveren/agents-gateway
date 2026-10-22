import { describe, expect, it } from 'vitest'
import { levelsFor } from './reasoning'

describe('levelsFor', () => {
  it('mantém só os níveis do protocolo, na ordem dele', () => {
    expect(levelsFor('claude', ['max', 'minimal', 'low'])).toEqual(['low', 'max'])
    expect(levelsFor('openai', ['high', 'none'])).toEqual(['none', 'high'])
    expect(levelsFor('google', ['low'])).toEqual([])
  })
})
