import { describe, expect, it } from 'vitest'
import { commandSuggestions } from './commands'

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
