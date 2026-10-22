import assert from 'node:assert'
import { describe, it } from 'node:test'
import { SqliteUserRepository } from '@infra/persistence/Sqlite.UserRepository'
import { HmacTokenIssuer } from './Hmac.TokenIssuer'
import { CompositeCallerProof, LocalCallerProof } from './Local.CallerProof'
import { ScryptPasswordHasher } from './Scrypt.PasswordHasher'

/** Custo baixo só no teste: o formato e a conferência são os mesmos, o tempo não. */
const hasher = new ScryptPasswordHasher({ N: 1024, r: 8, p: 1 })

describe('ScryptPasswordHasher', () => {
  it('confere a senha certa, recusa a errada, e cada hash tem salt próprio', () => {
    const hash = hasher.hash('frase longa o bastante')

    assert.ok(hash.startsWith('scrypt$1024$8$1$'))
    assert.strictEqual(hasher.verify('frase longa o bastante', hash), true)
    assert.strictEqual(hasher.verify('frase longa o bastantE', hash), false)
    assert.notStrictEqual(hasher.hash('frase longa o bastante'), hash)
  })

  it('hash ilegível é "não confere", nunca uma exceção', () => {
    assert.strictEqual(hasher.verify('x', 'lixo'), false)
    assert.strictEqual(hasher.verify('x', 'scrypt$a$b$c$d$e'), false)
  })
})

describe('HmacTokenIssuer', () => {
  const claims = { sub: 'u_1', email: 'ana@x.test', role: 'admin' as const }

  it('o token emitido confere e traz as claims', () => {
    const issuer = new HmacTokenIssuer('segredo')
    const { token } = issuer.issue(claims)

    assert.deepStrictEqual({ ...issuer.verify(token), exp: undefined }, { ...claims, exp: undefined })
    assert.strictEqual(issuer.owns(token), true)
  })

  it('⛔ recusa: outro segredo, payload trocado, alg none e token vencido', () => {
    const issuer = new HmacTokenIssuer('segredo')
    const { token } = issuer.issue({ ...claims, role: 'member' })
    const [header, , signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ iss: 'agents-gateway', sub: 'u_1', email: 'ana@x.test', role: 'admin', exp: 9e9 })).toString('base64url')
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')

    assert.strictEqual(new HmacTokenIssuer('outro').verify(token), undefined)
    assert.strictEqual(issuer.verify(`${header}.${forged}.${signature}`), undefined)
    assert.strictEqual(issuer.verify(`${none}.${forged}.`), undefined)

    let now = Date.now()
    const clocked = new HmacTokenIssuer('segredo', 1000, () => now)
    const short = clocked.issue(claims).token
    now += 2000
    assert.strictEqual(clocked.verify(short), undefined)
  })
})

describe('LocalCallerProof', () => {
  const setup = () => {
    const users = new SqliteUserRepository(':memory:')
    const tokens = new HmacTokenIssuer(users.signingSecret())
    const now = new Date()
    users.insert({ id: 'u_1', email: 'ana@x.test', name: 'Ana', role: 'admin', disabled: false, createdAt: now, updatedAt: now, passwordHash: 'x' })
    return { users, tokens, proof: new LocalCallerProof(tokens, users) }
  }

  it('vale enquanto a conta bate com o token', async () => {
    const { tokens, proof } = setup()
    assert.strictEqual(await proof.prove(tokens.issue({ sub: 'u_1', email: 'ana@x.test', role: 'admin' }).token), true)
  })

  it('⛔ cai NA HORA quando a conta é rebaixada ou desativada', async () => {
    const { users, tokens, proof } = setup()
    const { token } = tokens.issue({ sub: 'u_1', email: 'ana@x.test', role: 'admin' })

    users.update('u_1', { role: 'member' })
    assert.strictEqual(await proof.prove(token), false)

    users.update('u_1', { role: 'admin', disabled: true })
    assert.strictEqual(await proof.prove(token), false)
  })

  it('o segredo gerado fica no banco: o mesmo a cada leitura', () => {
    const { users } = setup()
    assert.strictEqual(users.signingSecret(), users.signingSecret())
  })

  it('composta: token de fora vai para a prova externa; sem ela, nenhuma prova responde por ele', async () => {
    const { tokens, proof } = setup()
    const external = { prove: async (token: string) => token === 'bom' }

    assert.strictEqual(await new CompositeCallerProof(proof, external).prove('bom'), true)
    assert.strictEqual(new CompositeCallerProof(proof).covers('de-fora'), false)
    assert.strictEqual(new CompositeCallerProof(proof).covers(tokens.issue({ sub: 'u_1', email: 'ana@x.test', role: 'admin' }).token), true)
  })
})
