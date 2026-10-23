import assert from 'node:assert'
import { describe, it } from 'node:test'
import { InvalidAccessTokenError } from '@domain/errors/Domain.Error'
import { ACCESS_TOKENS_PER_USER } from '@domain/models/AccessToken.Model'
import { HmacTokenIssuer } from '@infra/auth/Hmac.TokenIssuer'
import { ScryptPasswordHasher } from '@infra/auth/Scrypt.PasswordHasher'
import { SqliteAccessTokenRepository } from '@infra/persistence/Sqlite.AccessTokenRepository'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { AccessTokensService } from './AccessTokens.Service'
import { AccountsService } from './Accounts.Service'

const DAY = 86_400_000

describe('AccessTokensService', () => {
  const build = () => {
    let now = Date.parse('2026-10-22T12:00:00Z')
    const users = new SqliteUserRepository(':memory:')
    const issuer = new HmacTokenIssuer('s', 3_600_000, () => now)
    const accounts = new AccountsService(users, new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 }), issuer, () => now)
    const repository = new SqliteAccessTokenRepository(':memory:')
    const service = new AccessTokensService(repository, users, issuer, () => new Date(now))
    const admin = accounts.setup({ email: 'root@x.test', name: 'Root', password: 'frase longa o bastante' }, accounts.setupCode).user
    return { service, repository, users, issuer, accounts, admin, advance: (ms: number) => (now += ms) }
  }

  it('⛔ o token sai uma vez, como agw_…; o banco guarda só o hash e o prefixo', () => {
    const { service, repository, admin } = build()
    const { token, accessToken } = service.create(admin.id, { name: 'Claude Code' })

    assert.match(token, /^agw_[A-Za-z0-9_-]{43}$/)
    const [stored] = repository.listByUser(admin.id)
    assert.notStrictEqual(stored.tokenHash, token)
    assert.ok(!JSON.stringify(stored).includes(token.slice(8)))
    assert.strictEqual(accessToken.prefix, token.slice(0, 8))
    assert.ok(!('tokenHash' in service.list(admin.id)[0]))
  })

  it('a troca devolve um token de sessão da conta, com o papel de AGORA', () => {
    const { service, issuer, users, admin } = build()
    const { token } = service.create(admin.id, { name: 'script' })

    assert.strictEqual(issuer.verify(service.exchange(token)!)?.role, 'admin')
    users.update(admin.id, { role: 'member' })
    assert.strictEqual(issuer.verify(service.exchange(token)!)?.role, 'member')
  })

  it('⛔ recusa revogado, vencido, de conta desativada e qualquer coisa que não seja agw_', () => {
    const { service, users, admin, advance } = build()
    const revoked = service.create(admin.id, { name: 'a' })
    service.revoke(admin.id, revoked.accessToken.id)
    const expiring = service.create(admin.id, { name: 'b', expiresInDays: 1 })
    const active = service.create(admin.id, { name: 'c' })

    assert.strictEqual(service.exchange(revoked.token), undefined)
    assert.ok(service.exchange(expiring.token))
    advance(DAY + 1)
    assert.strictEqual(service.exchange(expiring.token), undefined)
    assert.strictEqual(service.exchange('agw_inventado'), undefined)
    assert.strictEqual(service.exchange('eyJhbGciOi.qualquer.coisa'), undefined)

    users.update(admin.id, { disabled: true })
    assert.strictEqual(service.exchange(active.token), undefined)
  })

  it('o último uso é gravado no máximo uma vez por minuto', () => {
    const { service, admin, advance } = build()
    const { token } = service.create(admin.id, { name: 'laço' })

    service.exchange(token)
    const first = service.list(admin.id)[0].lastUsedAt
    advance(30_000)
    service.exchange(token)
    assert.deepStrictEqual(service.list(admin.id)[0].lastUsedAt, first)
    advance(31_000)
    service.exchange(token)
    assert.notDeepStrictEqual(service.list(admin.id)[0].lastUsedAt, first)
  })

  it('regras: nome, validade e no máximo 20 ativos; revogar outro id é "não encontrado"', () => {
    const { service, admin } = build()

    assert.throws(() => service.create(admin.id, { name: ' ' }), InvalidAccessTokenError)
    assert.throws(() => service.create(admin.id, { name: 'x', expiresInDays: 400 }), InvalidAccessTokenError)
    for (let i = 0; i < ACCESS_TOKENS_PER_USER; i += 1) service.create(admin.id, { name: `t${i}` })
    assert.throws(() => service.create(admin.id, { name: 'demais' }), InvalidAccessTokenError)
    assert.throws(() => service.revoke('outra-conta', service.list(admin.id)[0].id), /not found/)
  })
})
