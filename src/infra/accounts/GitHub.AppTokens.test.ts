import assert from 'node:assert'
import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, it } from 'node:test'
import { appJwt, GitHubAppTokens } from './GitHub.AppTokens'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

describe('GitHub App: token de instalação', () => {
  it('o JWT do App é RS256, emitido pelo App e vale menos de 10 minutos', () => {
    const now = Date.UTC(2026, 9, 29, 12)
    const [header, payload, signature] = appJwt('123', pem, now).split('.')
    assert.deepStrictEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    assert.strictEqual(claims.iss, '123')
    assert.ok(claims.exp - claims.iat <= 600)
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')))
  })

  it('pede só os repositórios escolhidos e reaproveita o token até perto de vencer', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) })
      return new Response(JSON.stringify({ token: `ghs_${calls.length}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 })
    }) as typeof fetch
    const tokens = new GitHubAppTokens(http)
    const grant = { appId: '1', installationId: '99', privateKey: pem, repositories: ['api'] }
    assert.strictEqual((await tokens.token('p1:gh', grant)).token, 'ghs_1')
    assert.strictEqual((await tokens.token('p1:gh', grant)).token, 'ghs_1')
    assert.strictEqual(calls.length, 1)
    assert.match(calls[0].url, /\/app\/installations\/99\/access_tokens$/)
    assert.deepStrictEqual(JSON.parse(calls[0].body), { repositories: ['api'] })
  })

  it('recusa do GitHub vira erro legível', async () => {
    const http = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch
    await assert.rejects(new GitHubAppTokens(http).token('k', { appId: '1', installationId: '2', privateKey: pem }), /401\): Bad credentials/)
  })
})
