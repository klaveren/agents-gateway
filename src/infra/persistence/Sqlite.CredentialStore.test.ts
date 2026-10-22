import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { SecretBox } from '@infra/secrets/Aes.SecretBox'
import { SqliteCredentialStore } from './Sqlite.CredentialStore'

describe('SqliteCredentialStore', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-do-ambiente-9999' }

  it('salva vence ambiente; remover volta ao ambiente; sem nenhuma, nenhuma', () => {
    const store = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:', env)

    assert.strictEqual(store.get(EProvider.CLAUDE), 'sk-ant-do-ambiente-9999')
    store.save(EProvider.CLAUDE, '  sk-ant-da-tela-1234  ', 'root@x.test')
    assert.strictEqual(store.get(EProvider.CLAUDE), 'sk-ant-da-tela-1234')

    store.clear(EProvider.CLAUDE)
    assert.strictEqual(store.get(EProvider.CLAUDE), 'sk-ant-do-ambiente-9999')
    assert.strictEqual(store.get(EProvider.OPENAI), undefined)
  })

  it('⛔ o status mostra origem e final, NUNCA a chave', () => {
    const store = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:', env)
    store.save(EProvider.OPENAI, 'sk-proj-muito-secreta-abcd', 'root@x.test')

    const status = store.status(Object.values(EProvider))
    assert.ok(!JSON.stringify(status).includes('muito-secreta'))
    assert.ok(!JSON.stringify(status).includes('do-ambiente'))
    assert.deepStrictEqual(
      status.map((item) => [item.provider, item.source, item.last4]),
      [
        [EProvider.CLAUDE, 'env', '9999'],
        [EProvider.OPENAI, 'stored', 'abcd'],
        [EProvider.GOOGLE, 'none', undefined],
      ],
    )
  })

  it('sobrevive ao restart fechada no banco; com outra chave-mestra fica ilegível e o ambiente vale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'))
    try {
      const path = join(dir, 'gateway.db')
      const key = randomBytes(32)
      new SqliteCredentialStore(new SecretBox(key), path, env).save(EProvider.CLAUDE, 'sk-ant-da-tela-1234', 'root')

      assert.strictEqual(new SqliteCredentialStore(new SecretBox(key), path, env).get(EProvider.CLAUDE), 'sk-ant-da-tela-1234')

      const other = new SqliteCredentialStore(new SecretBox(randomBytes(32)), path, env)
      assert.strictEqual(other.get(EProvider.CLAUDE), 'sk-ant-do-ambiente-9999')
      assert.strictEqual(other.status(Object.values(EProvider))[0].unreadable, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('avisa quem escuta a cada troca', () => {
    const store = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:', {})
    const changed: string[] = []
    store.subscribe((provider) => changed.push(provider))

    store.save(EProvider.GOOGLE, 'AIza-teste-1234', 'root')
    store.clear(EProvider.GOOGLE)

    assert.deepStrictEqual(changed, [EProvider.GOOGLE, EProvider.GOOGLE])
  })
})
