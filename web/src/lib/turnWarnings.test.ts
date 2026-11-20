import { describe, expect, it } from 'vitest'
import { visibleWarnings } from './turnWarnings'

describe('visibleWarnings', () => {
  it('mostra o "Compactando" enquanto não há resultado', () => {
    expect(visibleWarnings(['Compactando o contexto (82% da janela de 1000000 tokens)…'])).toEqual(['Compactando o contexto (82% da janela de 1000000 tokens)…'])
  })

  it('troca o "Compactando" pelo resultado', () => {
    expect(visibleWarnings(['Compactando o contexto…', 'Contexto compactado: a conversa segue com um resumo.', 'Outro aviso'])).toEqual([
      'Contexto compactado: a conversa segue com um resumo.',
      'Outro aviso',
    ])
  })

  it('troca também quando o resumo falhou', () => {
    expect(visibleWarnings(['Compactando o contexto…', 'O resumo do contexto falhou: segue a transcrição.'])).toEqual(['O resumo do contexto falhou: segue a transcrição.'])
  })
})
