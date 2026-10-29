import { createPrivateKey, sign } from 'node:crypto'

type TFetch = typeof fetch

export interface IGitHubAppGrant {
  appId: string
  installationId: string
  privateKey: string
  /** Vazio = todos os repositórios da instalação. */
  repositories?: readonly string[]
}

export interface IGitHubInstallationToken {
  token: string
  expiresAt: Date
}

const API = 'https://api.github.com'
/** Reaproveita o token até faltar isto para vencer: o comando que pega um token quase vencido falha no meio. */
const RENEW_BEFORE_MS = 5 * 60_000

/** O JWT do App (RS256, 9 minutos; o GitHub aceita até 10), assinado com a chave privada dele. */
export function appJwt(appId: string, privateKey: string, now = Date.now()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const seconds = Math.floor(now / 1000)
  // `iat` 60s no passado: o relógio do GitHub pode estar adiantado em relação ao nosso.
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), createPrivateKey(privateKey)).toString('base64url')}`
}

/**
 * ⛔ O TOKEN DE INSTALAÇÃO DE UM GITHUB APP: 1h de vida, só nos repositórios escolhidos. É o que chega ao comando;
 * a chave privada do App nunca sai do gateway. Gerado AQUI, fora do cerco, e guardado até perto de vencer.
 */
export class GitHubAppTokens {
  private readonly cache = new Map<string, IGitHubInstallationToken>()

  constructor(private readonly http: TFetch = fetch) {}

  async token(cacheKey: string, grant: IGitHubAppGrant): Promise<IGitHubInstallationToken> {
    const cached = this.cache.get(cacheKey)
    if (cached && cached.expiresAt.getTime() - Date.now() > RENEW_BEFORE_MS) return cached
    const response = await this.http(`${API}/app/installations/${encodeURIComponent(grant.installationId)}/access_tokens`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${appJwt(grant.appId, grant.privateKey)}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'agents-gateway',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(grant.repositories?.length ? { repositories: grant.repositories } : {}),
    })
    const body = (await response.json().catch(() => ({}))) as { token?: string; expires_at?: string; message?: string }
    if (!response.ok || !body.token || !body.expires_at) throw new Error(`GitHub recusou o token do App (${response.status}): ${body.message ?? 'sem motivo'}`)
    const minted = { token: body.token, expiresAt: new Date(body.expires_at) }
    this.cache.set(cacheKey, minted)
    return minted
  }

  forget(prefix: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key)
  }
}

/** Quem é o token (`GET /user` para um PAT; os repositórios para o de instalação): o teste da tela. */
export async function describeGitHubToken(token: string, installation: boolean, http: TFetch = fetch): Promise<string> {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'agents-gateway' }
  const response = await http(installation ? `${API}/installation/repositories?per_page=100` : `${API}/user`, { headers })
  const body = (await response.json().catch(() => ({}))) as { login?: string; total_count?: number; repositories?: Array<{ full_name?: string }>; message?: string }
  if (!response.ok) throw new Error(`GitHub recusou o token (${response.status}): ${body.message ?? 'sem motivo'}`)
  if (!installation) return `conta ${body.login ?? '?'}`
  const names = (body.repositories ?? []).map((repo) => repo.full_name).filter(Boolean)
  return `${body.total_count ?? names.length} repositório(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}`
}
