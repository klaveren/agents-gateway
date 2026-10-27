import { describe, expect, it } from 'vitest'
import { contextMeter } from './contextMeter'

describe('contextMeter', () => {
  it('mostra o usado sobre a janela, com a porcentagem', () => {
    expect(contextMeter(45_000, 200_000)).toEqual({ label: '45.0k / 200.0k', short: '23%', percent: 23, warn: false })
  })

  it('avisa a partir de 80%, e não passa de 100', () => {
    expect(contextMeter(160_000, 200_000)?.warn).toBe(true)
    expect(contextMeter(300_000, 200_000)?.percent).toBe(100)
  })

  it('sem a janela do modelo, só o usado; sem o usado, nada', () => {
    expect(contextMeter(1_200, undefined)).toEqual({ label: '1.2k usados', short: '1.2k', warn: false })
    expect(contextMeter(624, 1_000_000)?.short).toBe('<1%')
    expect(contextMeter(undefined, 200_000)).toBeUndefined()
    expect(contextMeter(0, 200_000)).toBeUndefined()
  })
})
