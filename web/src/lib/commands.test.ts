import { describe, expect, it } from 'vitest'
import { commandSuggestions } from './commands'

describe('commandSuggestions', () => {
  const commands = [
    { id: 'resumir', description: 'Resume' },
    { id: 'revisar-pr', description: 'Revisa' },
    { id: 'pre-resumo', description: 'Outro' },
  ]

  it('só no começo da mensagem e enquanto digita o nome; pelo começo, depois pelo pedaço', () => {
    expect(commandSuggestions('/', commands).map((item) => item.id)).toEqual(['resumir', 'revisar-pr', 'pre-resumo'])
    expect(commandSuggestions('/re', commands).map((item) => item.id)).toEqual(['resumir', 'revisar-pr', 'pre-resumo'])
    expect(commandSuggestions('/resu', commands).map((item) => item.id)).toEqual(['resumir', 'pre-resumo'])
    expect(commandSuggestions('/resumir texto', commands)).toEqual([])
    expect(commandSuggestions('oi /resumir', commands)).toEqual([])
    expect(commandSuggestions('/', [])).toEqual([])
  })
})
