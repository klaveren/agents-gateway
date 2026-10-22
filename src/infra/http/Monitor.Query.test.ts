import assert from 'node:assert'
import { describe, it } from 'node:test'
import { metadataFilter, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, parsePageQuery, SEARCH_MAX } from './Monitor.Query'

describe('parsePageQuery', () => {
  it('o que não serve vira o padrão, em vez de erro', () => {
    assert.deepStrictEqual(parsePageQuery({ page: 'abc', pageSize: '-3' }), {
      page: 1,
      pageSize: PAGE_SIZE_DEFAULT,
      q: undefined,
      classification: undefined,
      provider: undefined,
      agentId: undefined,
    })
    assert.strictEqual(parsePageQuery({ page: '0' }).page, 1)
    assert.strictEqual(parsePageQuery({ page: '4' }).page, 4)
  })

  it('pageSize vai de 1 a 50', () => {
    assert.strictEqual(parsePageQuery({ pageSize: '1' }).pageSize, 1)
    assert.strictEqual(parsePageQuery({ pageSize: '25' }).pageSize, 25)
    assert.strictEqual(parsePageQuery({ pageSize: '100000' }).pageSize, PAGE_SIZE_MAX)
    assert.strictEqual(PAGE_SIZE_MAX, 50)
  })

  it('q é aparada e cortada em 100 caracteres; só texto vale', () => {
    assert.strictEqual(parsePageQuery({ q: '  ana  ' }).q, 'ana')
    assert.strictEqual(parsePageQuery({ q: 'x'.repeat(500) }).q?.length, SEARCH_MAX)
    assert.strictEqual(parsePageQuery({ q: '   ' }).q, undefined)
    assert.strictEqual(parsePageQuery({ q: ['a', 'b'] }).q, undefined)
  })

  it('classificação desconhecida é ignorada; provider só como identificador simples', () => {
    assert.strictEqual(parsePageQuery({ classification: 'red' }).classification, 'red')
    assert.strictEqual(parsePageQuery({ classification: 'purple' }).classification, undefined)
    assert.strictEqual(parsePageQuery({ provider: 'google' }).provider, 'google')
    assert.strictEqual(parsePageQuery({ provider: "x' OR 1=1" }).provider, undefined)
  })
})

describe('metadataFilter', () => {
  it('descarta as chaves da rota e as do dono, em qualquer caixa', () => {
    assert.deepStrictEqual(metadataFilter({ limit: '5', scope: 'all', owner: 'x', ownerId: 'x', OWNER: 'x', app: 'web' }), { app: 'web' })
  })

  it('só texto é rótulo: array e objeto saem', () => {
    assert.deepStrictEqual(metadataFilter({ a: ['1', '2'], b: { c: '1' }, d: 'ok' }), { d: 'ok' })
    assert.strictEqual(metadataFilter({ limit: '1' }), undefined)
  })

  it('descarta também as chaves reservadas pelo chamador', () => {
    assert.deepStrictEqual(metadataFilter({ page: '1', q: 'x', app: 'web' }, ['page', 'q']), { app: 'web' })
  })
})
