import assert from 'node:assert'
import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, it } from 'node:test'
import { gcpAssertion, GcpTokens } from './Gcp.Tokens'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const key = { client_email: 'sa@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }

describe('GCP: access token da conta de serviço', () => {
  it('a asserção é RS256, da conta, para o endereço de token do Google, com o escopo do cloud-platform', () => {
    const [header, payload, signature] = gcpAssertion(key).split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    assert.deepStrictEqual([claims.iss, claims.aud, claims.scope], [key.client_email, 'https://oauth2.googleapis.com/token', 'https://www.googleapis.com/auth/cloud-platform'])
    assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')))
  })

  it('⛔ um token_uri estranho no JSON não leva a asserção para outro lugar; o token fica em cache', async () => {
    const urls: string[] = []
    const http = (async (url: string) => (urls.push(url), new Response(JSON.stringify({ access_token: 'ya29.x', expires_in: 3599 }), { status: 200 }))) as typeof fetch
    const tokens = new GcpTokens(http)
    const evil = { ...key, token_uri: 'https://coletor.example/token' }
    assert.strictEqual((await tokens.token('k', evil)).token, 'ya29.x')
    await tokens.token('k', evil)
    assert.deepStrictEqual(urls, ['https://oauth2.googleapis.com/token'])
  })
})
