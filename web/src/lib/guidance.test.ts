import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { contextWeight, docSlug, rulesTokens, scopeLabel, scopeToProjectId } from './guidance'

describe('guidance', () => {
  const projects = [{ id: 'xpto', name: 'Loja XPTO', createdAt: '', updatedAt: '' }]

  it('o escopo: global ou o nome do projeto, e o projectId que a API grava', () => {
    expect([scopeLabel('global', projects), scopeLabel('xpto', projects), scopeLabel('sumiu', projects)]).toEqual(['Global', 'Loja XPTO', 'sumiu'])
    expect([scopeToProjectId('global'), scopeToProjectId('xpto')]).toEqual([null, 'xpto'])
  })

  it('o id do documento a partir do título', () => {
    expect(docSlug('ADR 7: Autenticação por sessão!')).toBe('adr-7-autenticacao-por-sessao')
  })

  it('o markdown da prévia ganha títulos, sem quebra de linha a mais', () => {
    expect(renderMarkdown('# Contexto\ntexto\n## Decisão')).toBe('<h2>Contexto</h2>texto<br><h3>Decisão</h3>')
    expect(renderMarkdown('#semtitulo')).toBe('#semtitulo')
  })

  it('o peso do contexto inicial soma as marcadas e avisa acima de 20k', () => {
    const tokens: Record<string, number> = { a: 15_000, b: 6_000 }
    expect(contextWeight(['a'], (id) => tokens[id])).toEqual({ total: 15_000, warn: false })
    expect(contextWeight(['a', 'b', 'sumiu'], (id) => tokens[id])).toEqual({ total: 21_000, warn: true })
  })
})

describe('rulesTokens', () => {
  it('só as ligadas, com o cabeçalho; nenhuma ligada, zero', () => {
    expect(rulesTokens([{ title: 'Idioma', body: 'Responda em português.', enabled: false }])).toBe(0)
    const one = rulesTokens([{ title: 'Idioma', body: 'Responda em português.', enabled: true }])
    expect(one).toBeGreaterThan(30)
    expect(
      rulesTokens([
        { title: 'Idioma', body: 'Responda em português.', enabled: true },
        { title: 'X', body: 'Y', enabled: false },
      ]),
    ).toBe(one)
  })
})
