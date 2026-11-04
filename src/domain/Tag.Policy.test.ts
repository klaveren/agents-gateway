import assert from 'node:assert'
import { describe, it } from 'node:test'
import { normalizeTag, normalizeTags, TAG_MAX, TAG_PATTERN, tagIssues } from './Tag.Policy'

describe('Tag.Policy', () => {
  it('normaliza: sem acento, minúscula, espaço vira hífen; o que não sobra nada é indefinido', () => {
    assert.strictEqual(normalizeTag('  Ínfra Core '), 'infra-core')
    assert.strictEqual(normalizeTag('logiccus_core'), 'logiccus-core')
    assert.strictEqual(normalizeTag('--a--b--'), 'a-b')
    assert.strictEqual(normalizeTag('!!!'), undefined)
    assert.ok(TAG_PATTERN.test(normalizeTag('x'.repeat(50))!))
  })

  it('a lista: sem repetir (a mesma depois de normalizada), na ordem; o inválido e o excesso são problemas', () => {
    assert.deepStrictEqual(normalizeTags(['Infra', 'infra ', 'ínfra', 'k3s']), ['infra', 'k3s'])
    assert.deepStrictEqual(tagIssues(['ok', '!!!']), [{ field: 'tags', message: '"!!!": use letters, digits or hyphens' }])
    assert.strictEqual(tagIssues(Array.from({ length: TAG_MAX + 1 }, (_, index) => `t${index}`)).length, 1)
    assert.deepStrictEqual(tagIssues(undefined), [])
  })
})
