import assert from 'node:assert'
import { describe, it } from 'node:test'
import { emptyTurnSummary } from './EmptyTurn.Policy'

describe('EmptyTurn.Policy', () => {
  it('⛔ o resumo é do gateway, diz a ferramenta e o motivo curto, e o próximo passo', () => {
    const text = emptyTurnSummary({ tool: 'run_bash', reason: 'Exit code 127: vitest: not found\nlinha 2\nlinha 3' })
    assert.match(text, /^\[gateway\] /)
    assert.match(text, /Parou em `run_bash`: Exit code 127: vitest: not found linha 2\./)
    assert.doesNotMatch(text, /linha 3/)
    assert.match(text, /Próximo passo:/)
  })

  it('motivo longo é cortado; motivo vazio vira "sem motivo informado"', () => {
    assert.ok(emptyTurnSummary({ tool: 'x', reason: 'a'.repeat(1000) }).length < 450)
    assert.match(emptyTurnSummary({ tool: 'x', reason: '  ' }), /sem motivo informado/)
  })
})
