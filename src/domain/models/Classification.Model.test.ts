import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isClassification, worstOf } from './Classification.Model'

/**
 * GUARD — a pior classificação vence. Se o rótulo da conversa fosse o do último turno, bastaria a
 * pessoa terminar perguntando algo banal para o sinal sumir da lista.
 */
describe('worstOf', () => {
  it('escolhe o pior, não o último nem o mais comum', () => {
    assert.equal(worstOf(['green', 'green', 'red', 'green']), 'red')
    assert.equal(worstOf(['green', 'amber']), 'amber')
    assert.equal(worstOf(['blue', 'green']), 'blue')
  })

  it('trata amber como pior que blue', () => {
    assert.equal(worstOf(['blue', 'amber']), 'amber')
  })

  it('ignora ausência e valor desconhecido', () => {
    assert.equal(worstOf([undefined, 'green']), 'green')
    assert.equal(worstOf([]), undefined)
    assert.equal(worstOf([undefined, undefined]), undefined)
    assert.equal(worstOf(['inventado' as never, 'green']), 'green')
  })
})

describe('isClassification', () => {
  it('só aceita as quatro', () => {
    assert.ok(['green', 'blue', 'amber', 'red'].every(isClassification))
    assert.equal(isClassification('purple'), false)
    assert.equal(isClassification(undefined), false)
  })
})
