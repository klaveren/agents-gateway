import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { docSlug, scopeLabel, scopeToProjectId } from './guidance'

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
})
