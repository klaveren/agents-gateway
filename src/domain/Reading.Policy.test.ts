import assert from 'node:assert'
import { describe, it } from 'node:test'
import { pagedText, plainFileRead, READ_PAGE_CHARS, readBudgetChars } from './Reading.Policy'

const lines = (count: number, width = 99) => Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(6, '0')}${'x'.repeat(width - 6)}`).join('\n')

describe('Reading.Policy — leitura longa em partes', () => {
  it('📏 o teto é 25% da janela, em caracteres (3 por token); sem janela, o de 128 mil', () => {
    assert.strictEqual(readBudgetChars(200_000), 150_000)
    assert.strictEqual(readBudgetChars(), 96_000)
    assert.strictEqual(readBudgetChars(1_000), READ_PAGE_CHARS)
  })

  it('📄 texto que cabe numa parte vai como está', () => {
    assert.deepStrictEqual(
      pagedText('curto', 100_000, () => ''),
      { text: 'curto' },
    )
  })

  it('📚 texto maior vai INTEIRO, em partes quebradas em fim de linha, sem o agente pedir a próxima', () => {
    const text = lines(500) // 50 mil caracteres
    const { text: out, stoppedAtLine } = pagedText(text, 100_000, () => 'X')
    assert.strictEqual(stoppedAtLine, undefined)
    assert.match(out, /── Parte 1\/3 ──/)
    assert.match(out, /── Parte 3\/3 ──/)
    assert.match(out, /── Fim \(3 partes\) ──$/)
    const body = out
      .split('\n')
      .filter((line) => !line.startsWith('──'))
      .join('\n')
    assert.strictEqual(body, text)
  })

  it('🛑 passou do teto: para numa parte inteira e diz de que linha continuar', () => {
    const text = lines(1_000) // 100 mil caracteres, 5 partes de ~20 mil
    const { text: out, stoppedAtLine } = pagedText(text, 45_000, (line) => `Continue em ${line}.`)
    assert.match(out, /── Parte 2\/5 ──/)
    assert.doesNotMatch(out, /Parte 3\/5/)
    assert.ok(stoppedAtLine && stoppedAtLine > 1)
    assert.match(out, new RegExp(`faltam 3 de 5 partes\\. Continue em ${stoppedAtLine}\\. ──$`))
    const lastShown = out
      .split('\n')
      .filter((line) => /^\d{6}/.test(line))
      .pop()!
    assert.strictEqual(Number(lastShown.slice(0, 6)) + 1, stoppedAtLine)
  })
})

describe('Reading.Policy — plainFileRead', () => {
  it('✅ reconhece só a leitura simples de arquivo', () => {
    assert.strictEqual(plainFileRead('cat docs/spec.md'), 'docs/spec.md')
    assert.strictEqual(plainFileRead("cat 'docs/spec.md'"), 'docs/spec.md')
    assert.strictEqual(plainFileRead('head -n 50 a.md'), 'a.md')
    assert.strictEqual(plainFileRead("sed -n '10,90p' a.md"), 'a.md')
  })

  it('⛔ qualquer pipe, encadeamento ou substituição fica no corte do terminal', () => {
    for (const command of ['cat a.md | grep x', 'cat a.md && rm b', 'cat $(ls)', 'cat a > b', 'ls', 'cat `x`', 'npm test'])
      assert.strictEqual(plainFileRead(command), undefined, command)
  })
})
