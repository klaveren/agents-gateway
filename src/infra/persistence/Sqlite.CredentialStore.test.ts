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

  it('o ambiente entra no cofre uma vez; a da tela vence; remover desliga de verdade', () => {
    const store = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:', env)

    assert.strictEqual(store.get(EProvider.CLAUDE), 'sk-ant-do-ambiente-9999')
    store.save(EProvider.CLAUDE, '  sk-ant-da-tela-1234  ', 'root@x.test')
    assert.strictEqual(store.get(EProvider.CLAUDE), 'sk-ant-da-tela-1234')

    store.clear(EProvider.CLAUDE)
    assert.strictEqual(store.get(EProvider.CLAUDE), undefined)
    assert.strictEqual(store.get(EProvider.OPENAI), undefined)
  })

  it('⛔ o status mostra origem e final, NUNCA a chave', () => {
    const store = new SqliteCredentialStore(new SecretBox(randomBytes(32)), ':memory:', env)
    store.save(EProvider.OPENAI, 'sk-proj-muito-secreta-abcd', 'root@x.test')

    const status = store.status([EProvider.CLAUDE, EProvider.OPENAI, EProvider.GOOGLE])
    assert.ok(!JSON.stringify(status).includes('muito-secreta'))
    assert.ok(!JSON.stringify(status).includes('do-ambiente'))
    assert.deepStrictEqual(
      status.map((item) => [item.provider, item.source, item.last4, item.updatedBy]),
      [
        [EProvider.CLAUDE, 'stored', '9999', 'env'],
        [EProvider.OPENAI, 'stored', 'abcd', 'root@x.test'],
        [EProvider.GOOGLE, 'none', undefined, undefined],
      ],
    )
  })

  it('a chave removida pela tela não volta do ambiente no boot seguinte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'))
    try {
      const path = join(dir, 'gateway.db')
      const key = randomBytes(32)
      new SqliteCredentialStore(new SecretBox(key), path, env).clear(EProvider.CLAUDE)

      assert.strictEqual(new SqliteCredentialStore(new SecretBox(key), path, env).get(EProvider.CLAUDE), undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sobrevive ao restart fechada no banco; com outra chave-mestra fica ilegível e nada vale', () => {
    const dir = mkdtempSync(join(tmpdir(), 'creds-'))
    try {
      const path = join(dir, 'gateway.db')
      const key = randomBytes(32)
      new SqliteCredentialStore(new SecretBox(key), path, env).save(EProvider.CLAUDE, 'sk-ant-da-tela-1234', 'root')

      assert.strictEqual(new SqliteCredentialStore(new SecretBox(key), path, env).get(EProvider.CLAUDE), 'sk-ant-da-tela-1234')

      const other = new SqliteCredentialStore(new SecretBox(randomBytes(32)), path, env)
      assert.strictEqual(other.get(EProvider.CLAUDE), undefined)
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
