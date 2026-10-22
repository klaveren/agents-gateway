import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { masterKey, SecretBox } from './Aes.SecretBox'

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32))

  it('abre o que fechou, e cada fechamento sai diferente (IV próprio)', () => {
    const sealed = box.seal('sk-ant-segredo')

    assert.strictEqual(box.open(sealed), 'sk-ant-segredo')
    assert.notStrictEqual(box.seal('sk-ant-segredo'), sealed)
    assert.ok(!sealed.includes('segredo'))
  })

  it('⛔ adulterado ou com outra chave-mestra não abre — devolve nada, não lixo', () => {
    const sealed = box.seal('sk-ant-segredo')
    const parts = sealed.split('.')
    parts[3] = Buffer.from('outra coisa').toString('base64url')

    assert.strictEqual(box.open(parts.join('.')), undefined)
    assert.strictEqual(new SecretBox(randomBytes(32)).open(sealed), undefined)
    assert.strictEqual(box.open('lixo'), undefined)
  })
})

describe('masterKey', () => {
  it('sem SECRETS_KEY, gera o arquivo uma vez, com permissão 0600, e relê o mesmo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'))
    try {
      const file = join(dir, 'sub', 'secrets.key')
      const first = masterKey(file, {})

      assert.strictEqual(first.length, 32)
      assert.strictEqual(statSync(file).mode & 0o777, 0o600)
      assert.deepStrictEqual(masterKey(file, {}), first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('SECRETS_KEY vence o arquivo, em hex ou base64, e tamanho errado lança', () => {
    const hex = randomBytes(32).toString('hex')

    assert.strictEqual(masterKey('/nao/usado', { SECRETS_KEY: hex }).toString('hex'), hex)
    assert.throws(() => masterKey('/nao/usado', { SECRETS_KEY: 'curta' }))
  })
})
