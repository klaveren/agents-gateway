import assert from 'node:assert'
import { describe, it } from 'node:test'
import { localToolPerimeter } from './Agent.Controller'

describe('localToolPerimeter', () => {
  const all = ['search_web', 'run_bash']

  it('⛔ LOCAL_TOOLS_ENABLED é o perímetro: o que não está lá não existe para nenhum agente', () => {
    assert.deepStrictEqual(localToolPerimeter(all, { LOCAL_TOOLS_ENABLED: 'search_web, inexistente' }), ['search_web'])
  })

  it('sem a variável: todas as locais', () => {
    assert.deepStrictEqual(localToolPerimeter(all, {}), all)
  })
})
