import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'
import { attachableDocs, attachedRefs, attachmentsChanged, contextWeight, docSlug, rulesTokens, scopeLabel, scopeToProjectId, setAttachMode } from './guidance'

describe('guidance', () => {
  const projects = [{ id: 'xpto', name: 'Loja XPTO', createdAt: '', updatedAt: '' }]

  it('o escopo: global ou o nome do projeto, e o projectId que a API grava', () => {
    expect([scopeLabel('global', projects), scopeLabel('xpto', projects), scopeLabel('sumiu', projects)]).toEqual(['Global', 'Loja XPTO', 'sumiu'])
    expect([scopeToProjectId('global'), scopeToProjectId('xpto')]).toEqual([null, 'xpto'])
  })

  it('o modo do anexo: por referência entra na lista, inteiro sai; só valem as dos anexados, na ordem deles', () => {
    expect(setAttachMode([], 'api', 'reference')).toEqual(['api'])
    expect(setAttachMode(['api', 'dados'], 'api', 'inline')).toEqual(['dados'])
    expect(setAttachMode(['api'], 'api', 'reference')).toEqual(['api'])
    expect(attachedRefs(['dados', 'api'], ['api', 'sumiu', 'dados'])).toEqual(['dados', 'api'])
  })

  it('editor de doc: o que ele pode anexar — o global só global; o de projeto, global ou do mesmo; nunca ele mesmo', () => {
    const docs = [{ id: 'api' }, { id: 'arq', projectId: 'xpto' }, { id: 'crm', projectId: 'crm' }, { id: 'eu', projectId: 'xpto' }]
    expect(attachableDocs(docs, null, 'api').map((doc) => doc.id)).toEqual([])
    expect(attachableDocs(docs, null).map((doc) => doc.id)).toEqual(['api'])
    expect(attachableDocs(docs, 'xpto', 'eu').map((doc) => doc.id)).toEqual(['api', 'arq'])
  })

  it('editor de doc: anexos mudaram (lista, ordem ou modo) liga o Salvar; referência solta não conta', () => {
    const saved = { docIds: ['api', 'erros'], docRefs: ['erros'] }
    expect(attachmentsChanged({ docIds: ['api', 'erros'], docRefs: ['erros'] }, saved)).toBe(false)
    expect(attachmentsChanged({ docIds: ['api', 'erros'], docRefs: ['erros', 'sumiu'] }, saved)).toBe(false)
    expect(attachmentsChanged({ docIds: ['api', 'erros'], docRefs: [] }, saved)).toBe(true)
    expect(attachmentsChanged({ docIds: ['erros', 'api'], docRefs: ['erros'] }, saved)).toBe(true)
    expect(attachmentsChanged({ docIds: [], docRefs: [] }, {})).toBe(false)
    expect(attachmentsChanged({ docIds: ['api'], docRefs: [] }, {})).toBe(true)
  })

  it('o id do documento a partir do título', () => {
    expect(docSlug('ADR 7: Autenticação por sessão!')).toBe('adr-7-autenticacao-por-sessao')
  })

  it('o markdown da prévia ganha títulos, sem quebra de linha a mais', () => {
    expect(renderMarkdown('# Contexto\ntexto\n## Decisão')).toBe('<h2>Contexto</h2>texto<h3>Decisão</h3>')
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
