import assert from 'node:assert'
import { describe, it } from 'node:test'
import { cliEnv } from '../ClaudeAgent.Adapter'
import { untestedCodex } from './Codex.Binary'

describe('Codex: só a versão testada', () => {
  it('outra versão recusa, a não ser com CODEX_ALLOW_UNTESTED=1', () => {
    assert.match(untestedCodex({}, () => 'codex-cli 0.200.0') ?? '', /not the tested version/)
    assert.strictEqual(
      untestedCodex({ CODEX_ALLOW_UNTESTED: '1' }, () => 'codex-cli 0.200.0'),
      undefined,
    )
  })
})

describe('cliEnv: o CLI do Claude não herda o ambiente do gateway', () => {
  it('⛔ só PATH, HOME e as variáveis da conexão', () => {
    const previous = process.env.SECRETS_KEY
    process.env.SECRETS_KEY = 'segredo-nao-pode-vazar'
    try {
      const official = cliEnv({ key: 'sk-ant-x', compatible: false })
      assert.strictEqual(official.ANTHROPIC_API_KEY, 'sk-ant-x')
      assert.ok(!JSON.stringify(official).includes('nao-pode-vazar'))
      const compatible = cliEnv({ key: 'k', baseUrl: 'https://x.test', compatible: true })
      assert.deepStrictEqual([compatible.ANTHROPIC_BASE_URL, compatible.ANTHROPIC_AUTH_TOKEN, compatible.ANTHROPIC_API_KEY], ['https://x.test', 'k', ''])
    } finally {
      if (previous === undefined) delete process.env.SECRETS_KEY
      else process.env.SECRETS_KEY = previous
    }
  })
})
