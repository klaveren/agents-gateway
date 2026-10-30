import assert from 'node:assert'
import { describe, it } from 'node:test'
import { EProvider } from './enums/EProvider.Enum'
import { CLI_ARG_MAX_BYTES, cliArgumentBytes, cliArgumentIssue, heaviestParts, promptParts } from './CliArgument.Policy'

describe('CliArgument.Policy', () => {
  it('o limite é o do Linux para um argumento: 128 KiB com o NUL do fim', () => {
    assert.strictEqual(CLI_ARG_MAX_BYTES, 131_071)
  })

  it('as partes do prompt montado saem pelos títulos `## `; o que vem antes é a instrução', () => {
    const parts = promptParts('Faça X.\n\n## Regras do ambiente\n1. r\n\n## Specs do projeto\n### A\ncorpo')
    assert.deepStrictEqual(
      parts.map((part) => part.label),
      ['Instrução do sistema', 'Regras do ambiente', 'Specs do projeto'],
    )
    assert.strictEqual(parts[0].bytes, Buffer.byteLength('Faça X.\n'))
    assert.strictEqual(
      parts.reduce((sum, part) => sum + part.bytes, 0) + parts.length - 1,
      Buffer.byteLength('Faça X.\n\n## Regras do ambiente\n1. r\n\n## Specs do projeto\n### A\ncorpo'),
    )
  })

  it('o soul e a instrução com o nome da tela', () => {
    assert.deepStrictEqual(
      promptParts('## Quem você é\nCalma.\n\n## Como você trabalha\nFaça X.').map((part) => part.label),
      ['Soul', 'Instrução do sistema'],
    )
  })

  it('o que mais pesa: do maior para o menor, os de mesmo título somados', () => {
    const heavy = heaviestParts([
      { label: 'a', bytes: 10 },
      { label: 'b', bytes: 30 },
      { label: 'a', bytes: 25 },
      { label: 'c', bytes: 1 },
    ])
    assert.deepStrictEqual(heavy, [
      { label: 'a', bytes: 35 },
      { label: 'b', bytes: 30 },
      { label: 'c', bytes: 1 },
    ])
  })

  it('o argumento do Codex conta o escape do TOML; o do Antigravity, a flag e o separador', () => {
    assert.strictEqual(cliArgumentBytes(EProvider.CODEX, 'a\n"b"'), Buffer.byteLength('developer_instructions="a\\n\\"b\\""'))
    assert.strictEqual(cliArgumentBytes(EProvider.ANTIGRAVITY, 'ação'), Buffer.byteLength('-p=ação\n\n---\n\n'))
  })

  it('abaixo do limite, nada; acima, o tamanho, o limite e o que pesa', () => {
    const parts = [
      { label: 'Specs do projeto', bytes: 90_000 },
      { label: 'Instrução do sistema', bytes: 40_000 },
      { label: 'Skills', bytes: 2_000 },
      { label: 'Commands', bytes: 500 },
    ]
    assert.strictEqual(cliArgumentIssue('Codex', CLI_ARG_MAX_BYTES, parts), undefined)
    const message = cliArgumentIssue('Codex', 140_000, parts)
    assert.ok(message)
    assert.match(message, /não cabe no Codex/)
    assert.match(message, /140\.000 bytes/)
    assert.match(message, /131\.071 bytes/)
    assert.match(message, /Specs do projeto \(87,9 KiB\), Instrução do sistema \(39,1 KiB\), Skills \(2 KiB\)/)
    assert.ok(!message.includes('Commands'))
  })
})
