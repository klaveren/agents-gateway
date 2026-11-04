import assert from 'node:assert'
import { describe, it } from 'node:test'
import { sumToolUsage, toolUsageOfTurn } from './ToolUsage.Model'

describe('ToolUsage.Model', () => {
  it('diretos = argumentos + resultado; no contexto = o resultado relido nos passos seguintes do turno', () => {
    const calls = [
      { tool: 'Read', args: { p: 'a' }, result: [{ type: 'text', text: 'x'.repeat(400) }] },
      { tool: 'run_bash', args: 'ls', result: [{ type: 'text', text: 'y'.repeat(40) }] },
      { tool: 'Read', args: { p: 'b' }, error: 'não existe' },
    ]
    const [read, bash] = toolUsageOfTurn(calls, 1_000_000)
    assert.deepStrictEqual({ tool: read.tool, calls: read.calls, errors: read.errors }, { tool: 'Read', calls: 2, errors: 1 })
    // 400 caracteres = 100 tokens, relidos pelos 2 passos seguintes; o erro é a última chamada (ninguém o relê).
    assert.strictEqual(read.contextTokens, 200)
    assert.strictEqual(bash.contextTokens, 10)
    assert.ok(read.directTokens > 100)
  })

  it('⚖️ o relido nunca passa da entrada que o provedor informou para o turno', () => {
    const calls = [
      { tool: 'Read', result: 'x'.repeat(4000) },
      { tool: 'Read', result: 'x' },
      { tool: 'Read', result: 'x' },
    ]
    const [read] = toolUsageOfTurn(calls, 300)
    assert.ok(read.contextTokens <= 300 && read.contextTokens >= 299, String(read.contextTokens))
  })

  it('soma os turnos e ordena pelo peso', () => {
    const turn = toolUsageOfTurn(
      [
        { tool: 'a', result: 'x'.repeat(40) },
        { tool: 'b', result: 'x'.repeat(4000) },
      ],
      1e6,
    )
    const total = sumToolUsage([turn, turn])
    assert.deepStrictEqual(
      total.map((item) => [item.tool, item.calls]),
      [
        ['b', 2],
        ['a', 2],
      ],
    )
  })
})
