import assert from 'node:assert'
import { describe, it } from 'node:test'
import { handoffText } from './Handoff.Policy'

describe('handoffText', () => {
  it('nada a repassar sem turno', () => {
    assert.strictEqual(handoffText([]), undefined)
  })

  it('cada turno com quem respondeu, o pedido, os arquivos, as ferramentas (sem repetir) e a resposta', () => {
    const text = handoffText([{ request: 'oi', files: ['a.pdf'], text: 'olá', tools: ['search_web', 'search_web'], by: 'claude · opus' }])!

    assert.match(text, /### Turno 1 \(claude · opus\)\nPessoa: oi\nArquivos anexados: a\.pdf\nFerramentas usadas: search_web\nAssistente: olá/)
    assert.match(text, /Mensagem nova:\]$/)
  })

  it('no teto, ficam os mais recentes e o bloco diz quantos saíram; o mais recente nunca some', () => {
    const turns = ['um', 'dois', 'três'].map((request) => ({ request, text: 'x'.repeat(50) }))
    const text = handoffText(turns, 120)!

    assert.match(text, /\[2 turno\(s\) mais antigo\(s\) omitido\(s\)\.\]/)
    assert.match(text, /Pessoa: três/)
    assert.doesNotMatch(text, /Pessoa: (um|dois)/)
    assert.match(handoffText([{ request: 'enorme', text: 'y'.repeat(500) }], 100)!, /\[…turno cortado\]/)
  })
})
