import { describe, expect, it } from 'vitest'
import { commandSuggestions, shownSlashTab, slashSuggestions } from './commands'

describe('commandSuggestions', () => {
  const commands = [
    { id: 'resumir', kind: 'command' as const, description: 'Resume um arquivo' },
    { id: 'revisar-pr', kind: 'command' as const, description: 'Revisa um pull request' },
    { id: 'tabela-markdown', kind: 'skill' as const, description: 'Montar tabelas em markdown' },
    { id: 'pre-resumo', kind: 'command' as const, description: 'Outro' },
  ]
  const ids = (text: string) => commandSuggestions(text, commands).map((item) => item.id)

  it('só no começo da mensagem e enquanto escolhe; com a barra sozinha, todos', () => {
    expect(ids('/')).toEqual(['resumir', 'revisar-pr', 'tabela-markdown', 'pre-resumo'])
    expect(ids('/resumir texto')).toEqual([])
    expect(ids('oi /resumir')).toEqual([])
    expect(commandSuggestions('/', [])).toEqual([])
  })

  it('busca no nome e na descrição, sem acento: começo do nome, depois o meio, depois a descrição', () => {
    expect(ids('/resu')).toEqual(['resumir', 'pre-resumo'])
    expect(ids('/markdown')).toEqual(['tabela-markdown'])
    expect(ids('/tabelas')).toEqual(['tabela-markdown'])
    expect(ids('/PULL')).toEqual(['revisar-pr'])
    // Sem acento: "resumé" acha a descrição "Resume".
    expect(ids('/resumé')).toEqual(['resumir'])
  })
})

describe('as guias do /', () => {
  const items = [
    { id: 'tabela-markdown', kind: 'skill' as const, description: 'Montar tabelas' },
    { id: 'resumir', kind: 'command' as const, description: 'Resume um arquivo' },
    { id: 'spec:api-rest', kind: 'spec' as const, description: 'API REST — Padrões de rota' },
    { id: 'knowledge:feature-flags', kind: 'knowledge' as const, description: 'Feature flags' },
  ]

  it('separa por tipo; resposta antiga sem tipo conta como command', () => {
    const matches = slashSuggestions('/', [...items, { id: 'velho', description: 'Sem tipo' }])
    expect(matches.skill.map((item) => item.id)).toEqual(['tabela-markdown'])
    expect(matches.command.map((item) => item.id)).toEqual(['resumir', 'velho'])
    expect(matches.adr).toEqual([])
  })

  it('a busca do seletor recorta a guia pelo nome e pela descrição, sem acento', () => {
    expect(slashSuggestions('/', items, 'padroes').spec.map((item) => item.id)).toEqual(['spec:api-rest'])
    expect(slashSuggestions('/', items, 'resume').command.map((item) => item.id)).toEqual(['resumir'])
    expect(slashSuggestions('/', items, 'nada-disso').skill).toEqual([])
  })

  it('a guia escolhida aparece; se ela não tem nada para o que foi digitado, a primeira que tem', () => {
    expect(shownSlashTab('skill', '/', slashSuggestions('/', items))).toBe('skill')
    expect(shownSlashTab('adr', '/', slashSuggestions('/', items))).toBe('adr')
    expect(shownSlashTab('skill', '/api', slashSuggestions('/api', items))).toBe('spec')
    expect(shownSlashTab('knowledge', '/flags', slashSuggestions('/flags', items))).toBe('knowledge')
    expect(shownSlashTab('skill', '/zzz', slashSuggestions('/zzz', items))).toBe('skill')
  })
})
