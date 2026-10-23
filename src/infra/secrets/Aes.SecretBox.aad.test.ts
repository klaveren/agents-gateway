import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { SecretBox } from './Aes.SecretBox'

describe('SecretBox — AAD', () => {
  it('⛔ o segredo de um dono não abre como o de outro; o formato antigo (v1) ainda abre', () => {
    const box = new SecretBox(randomBytes(32))
    const sealed = box.seal('sk-da-openai', 'openai')
    assert.strictEqual(box.open(sealed, 'openai'), 'sk-da-openai')
    assert.strictEqual(box.open(sealed, 'meu-compativel'), undefined)

    const legacy = sealed.replace(/^v2\./, 'v1.')
    assert.strictEqual(box.open(legacy, 'openai'), undefined, 'v1 de verdade não tem AAD; este é um v2 renomeado')
  })
})
