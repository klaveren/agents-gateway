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
    const { token, accessToken } = service.create(admin.id, { name: 'Claude Code', expiresInDays: 30 })

    assert.match(token, /^agw_[A-Za-z0-9_-]{43}$/)
    const [stored] = repository.listByUser(admin.id)
    assert.notStrictEqual(stored.tokenHash, token)
    assert.ok(!JSON.stringify(stored).includes(token.slice(8)))
    assert.strictEqual(accessToken.prefix, token.slice(0, 8))
    assert.ok(!('tokenHash' in service.list(admin.id)[0]))
  })

  it('🔌 o de conexão (agc_…) vale só como conexão do projeto dele: nunca vira sessão, e cai revogado ou vencido', () => {
    const { service, admin, advance } = build()
    const { token, accessToken } = service.create(admin.id, { name: 'meu gateway', expiresInDays: 1, projectId: 'logiccus' })

    assert.match(token, /^agc_[A-Za-z0-9_-]{43}$/)
    assert.strictEqual(accessToken.projectId, 'logiccus')
    assert.strictEqual(service.exchange(token), undefined)
    assert.strictEqual(service.exchange(`agw_${token.slice(4)}`), undefined)
    assert.deepStrictEqual(service.connection(token), { tokenId: accessToken.id, userId: admin.id, email: 'root@x.test', projectId: 'logiccus' })
    // O de acesso não é de conexão.
    assert.strictEqual(service.connection(service.create(admin.id, { name: 'script', expiresInDays: 1 }).token), undefined)

    advance(2 * DAY)
    assert.strictEqual(service.connection(token), undefined)
    const live = service.create(admin.id, { name: 'outro', expiresInDays: 30, projectId: 'logiccus' })
    service.revoke(admin.id, live.accessToken.id)
    assert.strictEqual(service.connection(live.token), undefined)
  })

  it('a troca devolve um token de sessão da conta, com o papel de AGORA', () => {
    const { service, issuer, users, admin } = build()
    const { token } = service.create(admin.id, { name: 'script', expiresInDays: 30 })

    assert.strictEqual(issuer.verify(service.exchange(token)!)?.role, 'admin')
    users.update(admin.id, { role: 'member' })
    assert.strictEqual(issuer.verify(service.exchange(token)!)?.role, 'member')
  })

  it('⛔ recusa revogado, vencido, de conta desativada e qualquer coisa que não seja agw_', () => {
    const { service, users, admin, advance } = build()
    const revoked = service.create(admin.id, { name: 'a', expiresInDays: 30 })
    service.revoke(admin.id, revoked.accessToken.id)
    const expiring = service.create(admin.id, { name: 'b', expiresInDays: 1 })
    const active = service.create(admin.id, { name: 'c', expiresInDays: 30 })

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
    const { token } = service.create(admin.id, { name: 'laço', expiresInDays: 30 })

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

    assert.throws(() => service.create(admin.id, { name: ' ', expiresInDays: 30 }), InvalidAccessTokenError)
    // ⛔ Sem validade, ou com validade acima do teto: recusa.
    assert.throws(() => service.create(admin.id, { name: 'x' } as never), InvalidAccessTokenError)
    assert.throws(() => service.create(admin.id, { name: 'x', expiresInDays: 400 }), InvalidAccessTokenError)
    for (let i = 0; i < ACCESS_TOKENS_PER_USER; i += 1) service.create(admin.id, { name: `t${i}`, expiresInDays: 30 })
    assert.throws(() => service.create(admin.id, { name: 'demais', expiresInDays: 30 }), InvalidAccessTokenError)
    assert.throws(() => service.revoke('outra-conta', service.list(admin.id)[0].id), /not found/)
  })

  it('⛔ a sessão derivada do agw_ leva a marca e cai quando o token é revogado ou vence', () => {
    const { service, issuer, admin, advance } = build()
    const { token, accessToken } = service.create(admin.id, { name: 'ci', expiresInDays: 1 })
    const claims = issuer.verify(service.exchange(token)!)!

    assert.strictEqual(claims.via, 'agw')
    assert.strictEqual(claims.tid, accessToken.id)
    assert.ok(service.isLive(admin.id, accessToken.id))
    advance(DAY + 1)
    assert.ok(!service.isLive(admin.id, accessToken.id))

    const other = service.create(admin.id, { name: 'outro', expiresInDays: 30 })
    service.revoke(admin.id, other.accessToken.id)
    assert.ok(!service.isLive(admin.id, other.accessToken.id))
  })
})
