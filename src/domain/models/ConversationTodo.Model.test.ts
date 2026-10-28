import assert from 'node:assert'
import { describe, it } from 'node:test'
import { TODO_MAX_ITEMS, todoIssues, todoText } from './ConversationTodo.Model'

describe('ConversationTodo', () => {
  it('aceita a lista certa; recusa vazia, título faltando, status desconhecido e acima do limite', () => {
    assert.deepStrictEqual(todoIssues([{ title: 'Ler', status: 'pending' }]), [])
    assert.match(todoIssues([])[0], /non-empty/)
    assert.match(todoIssues('x')[0], /non-empty/)
    assert.deepStrictEqual(todoIssues([{ title: ' ', status: 'pending' }]), ['items[0].title: required'])
    assert.match(todoIssues([{ title: 'Ler', status: 'feito' }])[0], /items\[0\]\.status/)
    assert.match(todoIssues(Array.from({ length: TODO_MAX_ITEMS + 1 }, () => ({ title: 'x', status: 'pending' })))[0], /at most/)
  })

  it('⛔ um item em andamento por vez', () => {
    const issues = todoIssues([
      { title: 'A', status: 'in_progress' },
      { title: 'B', status: 'in_progress' },
    ])
    assert.deepStrictEqual(issues, ['only one item can be in_progress at a time'])
  })

  it('o texto que volta ao modelo: a contagem e um item por linha, com o estado', () => {
    const text = todoText([
      { title: 'Ler', status: 'done' },
      { title: 'Escrever', status: 'in_progress' },
      { title: 'Revisar', status: 'pending' },
    ])
    assert.strictEqual(text, 'Tasks (1/3 done):\n[x] Ler\n[~] Escrever\n[ ] Revisar')
  })
})
