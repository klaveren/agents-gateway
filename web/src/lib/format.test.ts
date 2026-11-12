import { describe, expect, it } from 'vitest'
import { ago, redactUrl, sizeHint, span, tokens } from './format'

describe('span e ago', () => {
  it('a duração curta, na unidade que cabe', () => {
    expect(span(40_000)).toBe('40 s')
    expect(span(120_000)).toBe('2 min')
    expect(span(60 * 60_000)).toBe('1 h')
    expect(span(90 * 60_000)).toBe('1 h 30 min')
    expect(span(72 * 60 * 60_000)).toBe('3 dias')
    expect(span(-5)).toBe('0 s')
  })

  it('há quanto tempo: "agora" no primeiro minuto', () => {
    const now = new Date('2026-01-01T10:00:00Z')
    expect(ago('2026-01-01T09:59:30Z', now)).toBe('agora')
    expect(ago('2026-01-01T09:58:00Z', now)).toBe('há 2 min')
    expect(ago('2026-01-01T08:55:00Z', now)).toBe('há 1 h 5 min')
    expect(ago(undefined, now)).toBe('')
  })
})

describe('sizeHint', () => {
  it('mostra caracteres e tokens estimados, sem teto; diz quando pesa', () => {
    expect(sizeHint('x'.repeat(400))).toBe('400 caracteres · cerca de 100 tokens')
    expect(sizeHint('x'.repeat(300_000), 'quando carregado')).toBe('300.000 caracteres · cerca de 75 mil tokens quando carregado')
    expect(sizeHint('x'.repeat(10_200), 'a cada turno')).toBe('10.200 caracteres · cerca de 2,6 mil tokens a cada turno')
  })
})

describe('redactUrl', () => {
  it('tira usuário, senha, valores dos parâmetros e fragmento; fica o endereço', () => {
    expect(redactUrl('https://bot:s3nh4@mcp.exemplo.com:8443/mcp?token=abc&x=1&token=d#frag')).toBe('https://mcp.exemplo.com:8443/mcp?token=…&x=…')
    expect(redactUrl('https://mcp.exemplo.com/mcp')).toBe('https://mcp.exemplo.com/mcp')
  })

  it('o que não é URL: corta a consulta e o usuário mesmo assim', () => {
    expect(redactUrl('//user:pw@host/mcp?key=1')).toBe('//host/mcp')
    expect(redactUrl('')).toBe('')
  })
})

describe('tokens', () => {
  it('k, M, B e T: o número nunca passa de 999 na unidade', () => {
    expect(tokens(undefined)).toBe('0')
    expect(tokens(999)).toBe('999')
    expect(tokens(1_500)).toBe('1.5k')
    expect(tokens(58_700_000)).toBe('58.7M')
    expect(tokens(2_110_000_000)).toBe('2.11B')
    expect(tokens(2_043_600_000)).toBe('2.04B')
    expect(tokens(3_250_000_000_000)).toBe('3.25T')
  })

  it('o arredondamento que chegaria a 1000 sobe de unidade', () => {
    expect(tokens(999_960)).toBe('1.0M')
    expect(tokens(999_960_000)).toBe('1.00B')
    expect(tokens(999_940)).toBe('999.9k')
  })
})
