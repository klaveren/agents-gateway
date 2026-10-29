import { createPrivateKey, sign } from 'node:crypto'
import { IGcpServiceAccountKey } from '@domain/models/ProjectAccount.Model'

type TFetch = typeof fetch

const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const RENEW_BEFORE_MS = 5 * 60_000

/** A asserção da conta de serviço (RS256, 1h): o que o Google troca por um access token. */
export function gcpAssertion(key: IGcpServiceAccountKey, now = Date.now()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const seconds = Math.floor(now / 1000)
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || TOKEN_URI, iat: seconds, exp: seconds + 3600 })}`
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKeyOf(key.private_key)).toString('base64url')}`
}

/**
 * ⛔ O ACCESS TOKEN DE UMA CONTA DE SERVIÇO DO GCP: 1h de vida, gerado AQUI. A chave da conta (o JSON) nunca entra no
 * cerco; o comando recebe só o token (`CLOUDSDK_AUTH_ACCESS_TOKEN`).
 */
export class GcpTokens {
  private readonly cache = new Map<string, { token: string; expiresAt: Date }>()

  constructor(private readonly http: TFetch = fetch) {}

  async token(cacheKey: string, key: IGcpServiceAccountKey): Promise<{ token: string; expiresAt: Date }> {
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) return cached
    // ⛔ O endereço da troca é sempre o do Google: um `token_uri` qualquer no JSON levaria a chave assinada para outro lugar.
    const uri = key.token_uri && /^https:\/\/oauth2\.googleapis\.com\/token$/.test(key.token_uri) ? key.token_uri : TOKEN_URI
    const response = await this.http(uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: gcpAssertion({ ...key, token_uri: uri }) }).toString(),
    })
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
    if (!response.ok || !body.access_token) throw new Error(`o Google recusou a conta de serviço (${response.status}): ${body.error_description ?? body.error ?? 'sem motivo'}`)
    const minted = { token: body.access_token, expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000) }
    this.cache.set(cacheKey, minted)
    return minted
  }
}

/** Quem é o token e até quando vale: o teste da tela. */
export async function describeGcpToken(token: string, http: TFetch = fetch): Promise<string> {
  const response = await http(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`)
  const body = (await response.json().catch(() => ({}))) as { email?: string; expires_in?: string; error_description?: string }
  if (!response.ok) throw new Error(`o Google não reconheceu o token (${response.status}): ${body.error_description ?? 'sem motivo'}`)
  return `conta de serviço ${body.email ?? '?'}, token por mais ${Math.round(Number(body.expires_in ?? 0) / 60)} min`
}

/** A chave privada, com um erro que diz o que fazer (o do OpenSSL é "DECODER routines::unsupported"). */
function privateKeyOf(pem: string) {
  try {
    return createPrivateKey(pem)
  } catch {
    throw new Error('a private_key do JSON da conta de serviço não abre: cadastre de novo')
  }
}
