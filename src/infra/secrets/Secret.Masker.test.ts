import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { SecretBox } from './Aes.SecretBox'
import { SecretMasker } from './Secret.Masker'

describe('SecretMasker', () => {
  it('⛔ o segredo da conta vale na conversa que o recebeu; a chave do provider e o cadastrado valem em todas', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gw-mask-')), 'gateway.db')
    const masker = new SecretMasker(new SecretBox(randomBytes(32)), path, () => [{ value: 'sk-provider-key-0001', label: 'chave openai' }])
    masker.register('s1', [{ value: 'token-da-conta-777', label: 'GH_TOKEN' }])
    masker.saveValue('binance', 'Binance', 'segredo-cadastrado-42', 'admin')

    assert.strictEqual(masker.text('token-da-conta-777', 's1'), '[segredo:GH_TOKEN]')
    assert.strictEqual(masker.text('token-da-conta-777', 's2'), 'token-da-conta-777')
    assert.strictEqual(masker.text('sk-provider-key-0001 e segredo-cadastrado-42'), '[segredo:chave openai] e [segredo:Binance]')
    assert.strictEqual(masker.literalIn('curl -H "x: segredo-cadastrado-42"'), 'Binance')
    assert.deepStrictEqual(
      masker.values().map((value) => [value.id, value.label, value.last4]),
      [['binance', 'Binance', 'o-42']],
    )
    const db = new DatabaseSync(path)
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM secret_mask_values').all()).includes('segredo-cadastrado'))
    db.close()
    assert.ok(masker.recentHits().length >= 3 && masker.recentHits().every((hit) => !JSON.stringify(hit).includes('segredo-cadastrado')))
  })

  it('os nomes da tela entram na forma; remover para de mascarar', () => {
    const masker = new SecretMasker(new SecretBox(randomBytes(32)))
    masker.saveNames({ secret: ['CHAVE_PIX'], safe: [] })
    assert.strictEqual(masker.text('CHAVE_PIX=Zx81kLmnQ2pRt5vWy7'), 'CHAVE_PIX=[segredo:CHAVE_PIX]')
    masker.saveValue('x', 'X', 'valor-qualquer-99', 'admin')
    assert.ok(masker.removeValue('x'))
    assert.strictEqual(masker.text('valor-qualquer-99'), 'valor-qualquer-99')
  })
})
