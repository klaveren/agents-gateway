import { describe, expect, it } from 'vitest'
import { sizeHint } from './format'

describe('sizeHint', () => {
  it('mostra caracteres e tokens estimados, sem teto; diz quando pesa', () => {
    expect(sizeHint('x'.repeat(400))).toBe('400 caracteres · cerca de 100 tokens')
    expect(sizeHint('x'.repeat(300_000), 'quando carregado')).toBe('300.000 caracteres · cerca de 75 mil tokens quando carregado')
    expect(sizeHint('x'.repeat(10_200), 'a cada turno')).toBe('10.200 caracteres · cerca de 2,6 mil tokens a cada turno')
  })
})
