import { randomBytes } from 'node:crypto'
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  type OAuthServerInfo,
  refreshAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { IMcpServerConfig, mcpOAuthTokenKey, mcpSecretKey } from '@domain/models/McpServer.Model'
import { ICredentialStore } from '@domain/ports/CredentialStore.Port'

/** O login começado e não terminado vale isto: depois, o `state` não serve mais. */
const PENDING_MS = 10 * 60_000
/** O token é renovado quando falta menos que isto para vencer. */
const REFRESH_EARLY_MS = 60_000
/** Os endereços do login de um servidor, lidos uma vez e guardados por este tempo. */
const DISCOVERY_MS = 10 * 60_000

interface IStoredToken {
  accessToken: string
  refreshToken?: string
  /** Em ms desde a época. Ausente = não vence (ou o servidor não disse). */
  expiresAt?: number
  scope?: string
}

interface IPending {
  serverKey: string
  userId: string
  verifier: string
  redirectUri: string
  at: number
}

/**
 * ⚖️ O LOGIN OAUTH DOS MCPS REMOTOS (`auth: oauth`), POR PESSOA: quem conversa conecta a própria conta, e o gateway usa o
 * token DELA nas ferramentas desse MCP (ver `McpRegistry`, um cliente por pessoa). Os endereços do login saem do
 * próprio MCP (metadados OAuth do recurso protegido), salvo quando o cadastro diz o servidor de autorização.
 *
 * ⛔ O token nunca sai do processo: fica no cofre, cifrado, e só vira o header `Authorization` das chamadas ao MCP.
 * ⛔ O `state` é de uso único, vale 10 minutos e amarra o login a quem o começou: o retorno de outro navegador não
 * grava token de ninguém.
 */
export class McpOAuth {
  private readonly pending = new Map<string, IPending>()
  private readonly refreshing = new Map<string, Promise<string | undefined>>()
  private readonly discovered = new Map<string, { at: number; info: OAuthServerInfo }>()

  constructor(
    private readonly servers: { get(key: string): IMcpServerConfig | undefined },
    private readonly credentials: ICredentialStore,
    private readonly now: () => number = Date.now,
    private readonly fetchFn?: typeof fetch,
  ) {}

  /** O endereço para onde mandar a pessoa entrar. */
  async start(serverKey: string, userId: string, redirectUri: string): Promise<string> {
    const config = this.oauthConfig(serverKey)
    const info = await this.discover(serverKey, config)
    const state = randomBytes(24).toString('base64url')
    const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: { client_id: config.oauth!.clientId },
      redirectUrl: redirectUri,
      ...(config.oauth!.scopes ? { scope: config.oauth!.scopes } : {}),
      state,
      ...(info.resourceMetadata?.resource ? { resource: info.resourceMetadata.resource } : {}),
    })
    // O Google só devolve o token de renovação com estes dois: sem ele, a pessoa teria de entrar de novo a cada hora.
    if (authorizationUrl.hostname === 'accounts.google.com') {
      authorizationUrl.searchParams.set('access_type', 'offline')
      authorizationUrl.searchParams.set('prompt', 'consent')
    }
    this.sweep()
    this.pending.set(state, { serverKey, userId, verifier: codeVerifier, redirectUri, at: this.now() })
    return authorizationUrl.toString()
  }

  /** O retorno do login: troca o código pelo token e o guarda para quem começou. Devolve o servidor (para a tela). */
  async finish(state: string, code: string): Promise<{ serverKey: string }> {
    const pending = this.pending.get(state)
    this.pending.delete(state)
    if (!pending || this.now() - pending.at > PENDING_MS) throw new Error('the sign-in link expired or was already used; start again')
    const config = this.oauthConfig(pending.serverKey)
    const info = await this.discover(pending.serverKey, config)
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation: this.client(pending.serverKey, config),
      authorizationCode: code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      ...(info.resourceMetadata?.resource ? { resource: new URL(info.resourceMetadata.resource) } : {}),
      ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
    })
    this.store(pending.serverKey, pending.userId, {
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(tokens.expires_in ? { expiresAt: this.now() + tokens.expires_in * 1000 } : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    })
    return { serverKey: pending.serverKey }
  }

  /** O token em vigor da pessoa, renovado se está para vencer; `undefined` = ela não conectou (ou a renovação falhou). */
  async accessToken(serverKey: string, userId: string): Promise<string | undefined> {
    const stored = this.read(serverKey, userId)
    if (!stored) return undefined
    if (!stored.expiresAt || stored.expiresAt - REFRESH_EARLY_MS > this.now() || !stored.refreshToken) return stored.accessToken
    const key = mcpOAuthTokenKey(serverKey, userId)
    const running = this.refreshing.get(key)
    if (running) return running
    const refresh = this.refresh(serverKey, userId, stored).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refresh)
    return refresh
  }

  connected(serverKey: string, userId: string): boolean {
    return !!this.read(serverKey, userId)
  }

  disconnect(serverKey: string, userId: string): void {
    this.credentials.clear(mcpOAuthTokenKey(serverKey, userId))
  }

  private async refresh(serverKey: string, userId: string, stored: IStoredToken): Promise<string | undefined> {
    try {
      const config = this.oauthConfig(serverKey)
      const info = await this.discover(serverKey, config)
      const tokens = await refreshAuthorization(info.authorizationServerUrl, {
        metadata: info.authorizationServerMetadata,
        clientInformation: this.client(serverKey, config),
        refreshToken: stored.refreshToken!,
        ...(info.resourceMetadata?.resource ? { resource: new URL(info.resourceMetadata.resource) } : {}),
        ...(this.fetchFn ? { fetchFn: this.fetchFn } : {}),
      })
      const next: IStoredToken = {
        accessToken: tokens.access_token,
        // Quem não manda um token de renovação novo continua aceitando o antigo.
        refreshToken: tokens.refresh_token ?? stored.refreshToken,
        ...(tokens.expires_in ? { expiresAt: this.now() + tokens.expires_in * 1000 } : {}),
        ...((tokens.scope ?? stored.scope) ? { scope: tokens.scope ?? stored.scope } : {}),
      }
      this.store(serverKey, userId, next)
      return next.accessToken
    } catch (error) {
      console.warn(`[mcp-oauth] ${serverKey}: a renovação do token falhou; a pessoa precisa conectar de novo.`, error instanceof Error ? error.message : error)
      return undefined
    }
  }

  private oauthConfig(serverKey: string): IMcpServerConfig {
    const config = this.servers.get(serverKey)
    if (!config || config.auth !== 'oauth' || !config.oauth?.clientId) throw new Error(`the MCP server ${serverKey} does not use OAuth`)
    return config
  }

  private client(serverKey: string, config: IMcpServerConfig): { client_id: string; client_secret?: string } {
    const secret = this.credentials.get(mcpSecretKey(serverKey))
    return { client_id: config.oauth!.clientId, ...(secret ? { client_secret: secret } : {}) }
  }

  private async discover(serverKey: string, config: IMcpServerConfig): Promise<OAuthServerInfo> {
    const cached = this.discovered.get(serverKey)
    if (cached && this.now() - cached.at < DISCOVERY_MS) return cached.info
    const fetchFn = this.fetchFn ? { fetchFn: this.fetchFn } : {}
    let info: OAuthServerInfo
    if (config.oauth?.authorizationServer) {
      const metadata = await discoverAuthorizationServerMetadata(config.oauth.authorizationServer, fetchFn)
      info = { authorizationServerUrl: config.oauth.authorizationServer, ...(metadata ? { authorizationServerMetadata: metadata } : {}) }
    } else info = await discoverOAuthServerInfo(config.url, fetchFn)
    this.discovered.set(serverKey, { at: this.now(), info })
    return info
  }

  private read(serverKey: string, userId: string): IStoredToken | undefined {
    const raw = this.credentials.get(mcpOAuthTokenKey(serverKey, userId))
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as IStoredToken
      return typeof parsed.accessToken === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private store(serverKey: string, userId: string, token: IStoredToken): void {
    this.credentials.save(mcpOAuthTokenKey(serverKey, userId), JSON.stringify(token), userId)
  }

  private sweep(): void {
    for (const [state, pending] of this.pending) if (this.now() - pending.at > PENDING_MS) this.pending.delete(state)
  }
}
