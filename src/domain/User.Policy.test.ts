import assert from 'node:assert'
import { describe, it } from 'node:test'
import { IUser } from './models/User.Model'
import { newUserIssues, normalizeEmail, passwordIssue, userChangeIssues } from './User.Policy'

const user = (id: string, over: Partial<IUser> = {}): IUser => ({
  id,
  email: `${id}@x.test`,
  name: id,
  role: 'member',
  disabled: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
})

describe('User.Policy', () => {
  it('e-mail é a chave do login, em minúsculas', () => {
    assert.strictEqual(normalizeEmail('  Ana@X.Test '), 'ana@x.test')
  })

  it('senha: só comprimento conta, com piso e teto', () => {
    assert.ok(passwordIssue('curta'))
    assert.strictEqual(passwordIssue('frase longa o bastante'), undefined)
    assert.ok(passwordIssue('x'.repeat(201)))
  })

  it('conta nova: e-mail repetido (em qualquer caixa), nome vazio e senha curta voltam juntos', () => {
    const issues = newUserIssues({ email: 'ANA@x.test', name: ' ', password: 'curta', role: 'member' }, [user('ana')])

    assert.deepStrictEqual(
      issues.map((issue) => issue.field),
      ['email', 'name', 'password'],
    )
  })

  it('⛔ o último admin ativo não é rebaixado nem desativado', () => {
    const admin = user('root', { role: 'admin' })
    const users = [admin, user('ana')]

    assert.deepStrictEqual(
      userChangeIssues(admin, { role: 'member' }, 'ana', users).map((issue) => issue.field),
      ['role'],
    )
    assert.deepStrictEqual(
      userChangeIssues(admin, { disabled: true }, 'ana', users).map((issue) => issue.field),
      ['disabled'],
    )
  })

  it('com outro admin ativo, rebaixar pode; admin desativado não conta como o outro', () => {
    const admin = user('root', { role: 'admin' })

    assert.deepStrictEqual(userChangeIssues(admin, { role: 'member' }, 'x', [admin, user('bia', { role: 'admin' })]), [])
    assert.strictEqual(userChangeIssues(admin, { role: 'member' }, 'x', [admin, user('bia', { role: 'admin', disabled: true })]).length, 1)
  })

  it('⛔ ninguém desativa a própria conta', () => {
    const ana = user('ana')

    assert.deepStrictEqual(
      userChangeIssues(ana, { disabled: true }, 'ana', [ana, user('root', { role: 'admin' })]).map((issue) => issue.message),
      ['you cannot disable your own account'],
    )
  })
})
