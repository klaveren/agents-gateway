import assert from 'node:assert'
import { afterEach, describe, it } from 'node:test'
import { identityFromToken, readPath, tokenFromHeader } from './Caller.Identity'

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

const CLAIM_ENVS = ['CALLER_ID_CLAIM', 'CALLER_EMAIL_CLAIM', 'CALLER_ROLE_CLAIM', 'CALLER_ACCOUNT_CLAIM']

describe('identityFromToken', () => {
  afterEach(() => {
    for (const name of CLAIM_ENVS) delete process.env[name]
  })

  it('lê os claims planos padrão (sub, email, role)', () => {
    assert.deepStrictEqual(identityFromToken(jwt({ sub: 'u1', email: 'a@x.test', role: 'admin', outro: 1 })), { id: 'u1', email: 'a@x.test', role: 'admin' })
  })

  it('conta só existe quando CALLER_ACCOUNT_CLAIM é configurado', () => {
    const token = jwt({ sub: 'u1', account: 'acc-1' })
    assert.strictEqual(identityFromToken(token).account, undefined)

    process.env.CALLER_ACCOUNT_CLAIM = 'account'
    assert.strictEqual(identityFromToken(token).account, 'acc-1')
  })

  it('desce em caminho com pontos (claims aninhados)', () => {
    process.env.CALLER_ID_CLAIM = 'user.id'
    process.env.CALLER_EMAIL_CLAIM = 'user.email'
    process.env.CALLER_ROLE_CLAIM = 'user.type'
    process.env.CALLER_ACCOUNT_CLAIM = 'account.alias'

    const token = jwt({ user: { id: 'u9', email: 'n@x.test', type: 'seller' }, account: { alias: 'acme' } })

    assert.deepStrictEqual(identityFromToken(token), { id: 'u9', email: 'n@x.test', role: 'seller', account: 'acme' })
  })

  it('chave que já tem pontos (claim namespaced) vale como está', () => {
    process.env.CALLER_ROLE_CLAIM = 'https://x.example/role'

    assert.strictEqual(identityFromToken(jwt({ sub: 'u1', 'https://x.example/role': 'ops' })).role, 'ops')
  })

  it('id numérico vira texto; objeto, booleano e vazio não são identidade', () => {
    assert.strictEqual(identityFromToken(jwt({ sub: 42 })).id, '42')
    assert.deepStrictEqual(identityFromToken(jwt({ sub: { a: 1 }, email: true, role: '  ' })), {})
  })

  it('caminho que não existe devolve vazio, sem lançar', () => {
    process.env.CALLER_ID_CLAIM = 'user.id'

    assert.deepStrictEqual(identityFromToken(jwt({ user: 'texto' })), {})
    assert.deepStrictEqual(identityFromToken(jwt({})), {})
  })

  it('token que não é JWT legível não lança', () => {
    for (const token of ['abc', 'a.b.c', 'a..c', '', 'a.%%%.c', `a.${Buffer.from('null').toString('base64url')}.c`]) {
      assert.deepStrictEqual(identityFromToken(token), {}, token)
    }
  })

  it('não herda propriedade do protótipo', () => {
    assert.strictEqual(readPath({}, 'constructor'), undefined)
    assert.strictEqual(readPath({ a: {} }, 'a.__proto__'), undefined)
  })
})

describe('tokenFromHeader', () => {
  it('aceita com e sem Bearer, e recusa vazio', () => {
    assert.strictEqual(tokenFromHeader('Bearer abc'), 'abc')
    assert.strictEqual(tokenFromHeader('abc'), 'abc')
    assert.strictEqual(tokenFromHeader(['abc']), 'abc')
    assert.strictEqual(tokenFromHeader('Bearer  '), undefined)
    assert.strictEqual(tokenFromHeader(undefined), undefined)
  })
})
