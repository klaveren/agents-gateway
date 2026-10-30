import { describe, expect, it } from 'vitest'
import { redactUrl, sizeHint } from './format'

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
