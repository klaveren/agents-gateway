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

  it('⛔ setup: só com o código do log, só uma vez, e cria admin já logado', async () => {
    const { service } = build()

    assert.throws(() => service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, undefined), SetupUnavailableError)
    assert.throws(() => service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, 'AAAA-BBBB-CCCC'), SetupUnavailableError)
    const session = service.setup({ email: 'Root@X.test', name: 'Root', password: PASSWORD }, service.setupCode)
    assert.strictEqual(session.user.role, 'admin')
    assert.strictEqual(session.user.email, 'root@x.test')
    assert.throws(() => service.setup({ email: 'outro@x.test', name: 'Outro', password: PASSWORD }, service.setupCode), SetupUnavailableError)
  })

  it('login: a mesma recusa para e-mail inexistente, senha errada e conta desativada', async () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode).user
    const ana = service.create({ email: 'ana@x.test', name: 'Ana', password: PASSWORD, role: 'member' }, 'root@x.test')
    service.update(ana.id, { disabled: true }, root.id, 'root@x.test')

    await assert.rejects(service.login('ninguem@x.test', PASSWORD), InvalidCredentialsError)
    await assert.rejects(service.login('root@x.test', 'senha errada!!'), InvalidCredentialsError)
    await assert.rejects(service.login('ana@x.test', PASSWORD), InvalidCredentialsError)
    assert.ok((await service.login('ROOT@x.test', PASSWORD)).token)
    assert.ok(service.me(root.id).lastLoginAt)
  })

  it('⛔ força bruta: cinco falhas travam o e-mail, mesmo com a senha certa depois; a trava vence', async () => {
    const { service, advance } = build()
    service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode)

    for (let attempt = 0; attempt < LOCK_AFTER_FAILURES; attempt++) await assert.rejects(service.login('root@x.test', 'errada errada'), InvalidCredentialsError)
    await assert.rejects(service.login('root@x.test', PASSWORD), LoginLockedError)

    advance(LOCK_MS + 1)
    assert.ok((await service.login('root@x.test', PASSWORD)).token)
  })

  it('⛔ o último admin não sai; com dois, um pode tirar o admin do outro', async () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode).user

    assert.throws(() => service.update(root.id, { role: 'member' }, root.id, 'root'), InvalidUserError)

    const bia = service.create({ email: 'bia@x.test', name: 'Bia', password: PASSWORD, role: 'admin' }, 'root')
    assert.strictEqual(service.update(root.id, { role: 'member' }, bia.id, 'bia').role, 'member')
  })

  it('trocar a própria senha exige a atual; a nova passa a valer', async () => {
    const { service } = build()
    const root = service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode).user

    assert.throws(() => service.changeOwnPassword(root.id, 'não é esta', 'outra frase longa'), InvalidUserError)
    service.changeOwnPassword(root.id, PASSWORD, 'outra frase longa')
    assert.ok((await service.login('root@x.test', 'outra frase longa')).token)
  })

  it('⛔ a trava é por e-mail E origem: quem erra de fora não tranca o admin que entra de outro lugar', async () => {
    const { service } = build()
    service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode)

    for (let attempt = 0; attempt < LOCK_AFTER_FAILURES; attempt++) await assert.rejects(service.login('root@x.test', 'errada errada', '203.0.113.9'), InvalidCredentialsError)
    await assert.rejects(service.login('root@x.test', PASSWORD, '203.0.113.9'), LoginLockedError)
    assert.ok((await service.login('root@x.test', PASSWORD, '127.0.0.1')).token)
  })

  it('o hash nunca sai: a lista é de contas, sem senha', async () => {
    const { service } = build()
    service.setup({ email: 'root@x.test', name: 'Root', password: PASSWORD }, service.setupCode)

    assert.ok(!JSON.stringify(service.list()).includes('scrypt$'))
  })
})
