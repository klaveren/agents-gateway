import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InvalidCredentialsError, InvalidUserError, LoginLockedError, SetupUnavailableError } from '@domain/errors/Domain.Error'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { ScryptPasswordHasher } from '@infra/auth/Scrypt.PasswordHasher'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { AccountsService, LOCK_AFTER_FAILURES, LOCK_MS } from './Accounts.Service'

const PASSWORD = 'frase longa o bastante'

describe('AccountsService', () => {
  const build = () => {
    let now = Date.parse('2026-10-22T12:00:00Z')
    const users = new SqliteUserRepository(':memory:')
    const service = new AccountsService(users, new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 }), new HmacTokenIssuer('s', 3_600_000, () => now), () => now)
    return { service, users, advance: (ms: number) => (now += ms) }
  }

  it('⛔ setup: só desta máquina, só uma vez, e cria admin já logado', () => {
    const { service } = build()

    assert.throws(() => service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, false), SetupUnavailableError)
    const session = service.setup({ email: 'Root@X.test', name: 'Root', password: PASSWORD }, true)
    assert.strictEqual(session.user.role, 'admin')
    assert.strictEqual(session.user.email, 'root@x.test')
    assert.throws(() => service.setup({ email: 'outro@x.test', name: 'Outro', password: PASSWORD }, true), SetupUnavailableError)
  })

  it('login: a mesma recusa para e-mail inexistente, senha errada e conta desativada', () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, true).user
    const ana = service.create({ email: 'ana@x.test', name: 'Ana', password: PASSWORD, role: 'member' }, 'root@x.test')
    service.update(ana.id, { disabled: true }, root.id, 'root@x.test')

    assert.throws(() => service.login('ninguem@x.test', PASSWORD), InvalidCredentialsError)
    assert.throws(() => service.login('root@x.test', 'senha errada!!'), InvalidCredentialsError)
    assert.throws(() => service.login('ana@x.test', PASSWORD), InvalidCredentialsError)
    assert.ok(service.login('ROOT@x.test', PASSWORD).token)
    assert.ok(service.me(root.id).lastLoginAt)
  })

  it('⛔ força bruta: cinco falhas travam o e-mail, mesmo com a senha certa depois; a trava vence', () => {
    const { service, advance } = build()
    service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, true)

    for (let attempt = 0; attempt < LOCK_AFTER_FAILURES; attempt++) assert.throws(() => service.login('root@x.test', 'errada errada'), InvalidCredentialsError)
    assert.throws(() => service.login('root@x.test', PASSWORD), LoginLockedError)

    advance(LOCK_MS + 1)
    assert.ok(service.login('root@x.test', PASSWORD).token)
  })

  it('⛔ o último admin não sai; com dois, um pode tirar o admin do outro', () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, true).user

    assert.throws(() => service.update(root.id, { role: 'member' }, root.id, 'root'), InvalidUserError)

    const bia = service.create({ email: 'bia@x.test', name: 'Bia', password: PASSWORD, role: 'admin' }, 'root')
    assert.strictEqual(service.update(root.id, { role: 'member' }, bia.id, 'bia').role, 'member')
  })

  it('trocar a própria senha exige a atual; a nova passa a valer', () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, true).user

    assert.throws(() => service.changeOwnPassword(root.id, 'não é esta', 'outra frase longa'), InvalidUserError)
    service.changeOwnPassword(root.id, PASSWORD, 'outra frase longa')
    assert.ok(service.login('root@x.test', 'outra frase longa').token)
  })

  it('o hash nunca sai: a lista é de contas, sem senha', () => {
    const { service } = build()
    service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, true)

    assert.ok(!JSON.stringify(service.list()).includes('scrypt$'))
  })
})
