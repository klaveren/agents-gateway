import { createHash, randomBytes } from 'node:crypto'
import { AccessTokenNotFoundError, InvalidAccessTokenError } from '@domain/errors/Domain.Error'
import {
  ACCESS_TOKEN_MAX_DAYS,
  ACCESS_TOKEN_NAME_MAX,
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKENS_PER_USER,
  IAccessToken,
  IStoredAccessToken,
  isAccessToken,
} from '@domain/models/AccessToken.Model'
import { IAccessTokenRepository } from '@domain/ports/AccessTokenRepository.Port'
import { ITokenIssuer } from '@domain/ports/TokenIssuer.Port'
import { IUserRepository } from '@domain/ports/UserRepository.Port'

const DAY = 86_400_000
/** O "último uso" é gravado no máximo uma vez por minuto: um script em laço não vira uma escrita por chamada. */
const LAST_USED_EVERY_MS = 60_000

/**
 * Os tokens de acesso pessoais.
 *
 * ⚖️ A TROCA NA PORTA (`exchange`): o token de acesso não é verificado em lugar nenhum além daqui. Ele é
 * trocado, a cada requisição, por um token de SESSÃO novo da conta — com o papel e a geração de agora —, e
 * dali em diante prova, dono e admin funcionam como sempre. Esse token de sessão nunca volta ao cliente.
 */
export class AccessTokensService {
  constructor(
    private readonly tokens: IAccessTokenRepository,
    private readonly users: IUserRepository,
    private readonly sessions: ITokenIssuer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** ⛔ O token em claro sai UMA vez, aqui; o banco guarda só o hash. */
  create(userId: string, input: { name: string; expiresInDays?: number }): { token: string; accessToken: IAccessToken } {
    const issues: Array<{ field: string; message: string }> = []
    const name = input.name.trim()
    if (!name) issues.push({ field: 'name', message: 'required' })
    else if (name.length > ACCESS_TOKEN_NAME_MAX) issues.push({ field: 'name', message: `at most ${ACCESS_TOKEN_NAME_MAX} characters` })
    if (input.expiresInDays !== undefined && (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > ACCESS_TOKEN_MAX_DAYS))
      issues.push({ field: 'expiresInDays', message: `1 to ${ACCESS_TOKEN_MAX_DAYS} days, or none` })
    if (this.list(userId).filter((token) => this.usable(token)).length >= ACCESS_TOKENS_PER_USER)
      issues.push({ field: 'name', message: `at most ${ACCESS_TOKENS_PER_USER} active tokens; revoke one first` })
    if (issues.length) throw new InvalidAccessTokenError(issues)

    const token = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const now = this.now()
    const stored: IStoredAccessToken = {
      id: `tok_${randomBytes(9).toString('base64url')}`,
      userId,
      name,
      tokenHash: hash(token),
      prefix: token.slice(0, ACCESS_TOKEN_PREFIX.length + 4),
      createdAt: now,
      expiresAt: input.expiresInDays ? new Date(now.getTime() + input.expiresInDays * DAY) : undefined,
    }
    this.tokens.insert(stored)
    return { token, accessToken: withoutHash(stored) }
  }

  list(userId: string): IAccessToken[] {
    return this.tokens.listByUser(userId).map(withoutHash)
  }

  /** Só os da própria conta: o id de outro responde igual ao inexistente. */
  revoke(userId: string, id: string): void {
    const token = this.tokens.listByUser(userId).find((candidate) => candidate.id === id)
    if (!token) throw new AccessTokenNotFoundError(id)
    this.tokens.update(id, { revokedAt: this.now() })
  }

  /**
   * Revoga TODOS os tokens ativos de uma conta. ⛔ É o que a troca de senha pelo admin e o "encerrar
   * sessões" fazem também: antes, um `agw_` sobrevivia aos dois e seguia valendo por até um ano.
   */
  revokeAll(userId: string): number {
    const active = this.tokens.listByUser(userId).filter((token) => !token.revokedAt)
    for (const token of active) this.tokens.update(token.id, { revokedAt: this.now() })
    return active.length
  }

  /**
   * O token de acesso → um token de sessão da conta, ou nada.
   * ⛔ Recusa revogado, vencido, de conta apagada ou desativada.
   */
  exchange(raw: string): string | undefined {
    if (!isAccessToken(raw)) return undefined
    const token = this.tokens.findByHash(hash(raw))
    if (!token || !this.usable(token)) return undefined

    const user = this.users.findById(token.userId)
    if (!user || user.disabled) return undefined

    const now = this.now()
    if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) this.tokens.update(token.id, { lastUsedAt: now })

    return this.sessions.issue({ sub: user.id, email: user.email, role: user.role, ver: user.sessionVersion }).token
  }

  private usable(token: IAccessToken): boolean {
    return !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > this.now().getTime())
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function withoutHash(token: IStoredAccessToken): IAccessToken {
  const { tokenHash: _hash, ...rest } = token
  return rest
}
