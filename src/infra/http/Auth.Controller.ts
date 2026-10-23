import { AccessTokensService } from '@application/AccessTokens.Service'
import { AccountsService, ISession } from '@application/Accounts.Service'
import { IAccessToken, isAccessToken } from '@domain/models/AccessToken.Model'
import { IUser } from '@domain/models/User.Model'
import { NextFunction, Request, Response } from 'express'
import { provenCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { CALLER_HEADER } from './Security.Middleware'
import { createAccessTokenSchema, changePasswordSchema, createUserSchema, loginSchema, resetPasswordSchema, setupSchema, updateUserSchema } from './Request.Schema'

export interface IAuthControllerDeps {
  /** Ausente = sem contas locais (`CONVERSATIONS_DB=off`): as rotas respondem 404, o status diz que não há. */
  accounts?: AccountsService
  proof?: ICallerProof
  /** Os tokens de acesso pessoais. Ausente junto com as contas locais. */
  accessTokens?: AccessTokensService
}

/** Marca, em `res.locals`, que a requisição chegou com um token de acesso (trocado na porta). */
const VIA_ACCESS_TOKEN = 'viaAccessToken'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * O pedido veio DESTA máquina, sem passar por proxy?
 *
 * ⚠️ O ENDEREÇO DO SOCKET, não `req.ip`: com `trust proxy` ligado o `req.ip` vem do cabeçalho, e o
 * cabeçalho se escreve. E com `X-Forwarded-For` presente o pedido passou por um proxy — que pode estar
 * nesta máquina repassando a internet inteira; aí não é loopback para o que importa aqui.
 */
export function isLoopback(req: Request): boolean {
  return LOOPBACK.has(req.socket?.remoteAddress ?? '') && !req.headers['x-forwarded-for']
}

/** Login, sessão e a tela de Usuários. Separado do `AgentController`: é outro assunto, com outra porta. */
export class AuthController {
  constructor(private readonly deps: IAuthControllerDeps) {
    for (const name of [
      'status',
      'setup',
      'login',
      'logout',
      'me',
      'changePassword',
      'listUsers',
      'createUser',
      'updateUser',
      'resetPassword',
      'revokeSessions',
      'listTokens',
      'createToken',
      'revokeToken',
    ] as const) {
      this[name] = this[name].bind(this)
    }
    this.accessTokenGate = this.accessTokenGate.bind(this)
  }

  /**
   * A TROCA NA PORTA: um token de acesso (`agw_…`) no header da conta vira, só nesta requisição, um token de
   * sessão novo da conta (ver `AccessTokensService.exchange`). Dali em diante prova, dono e admin funcionam
   * sem saber que houve troca — e o MCP repassa o header já trocado às próprias chamadas.
   *
   * ⛔ Token de acesso que não vale é 401 AQUI, e não "sem identidade" mais adiante: com ele no header, a
   * pessoa quis se identificar, e cair no anônimo esconderia que o token foi revogado.
   */
  accessTokenGate(req: Request, res: Response, next: NextFunction) {
    const header = req.headers[CALLER_HEADER]
    const raw = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : ''
    if (!isAccessToken(raw)) return next()

    const session = this.deps.accessTokens?.exchange(raw)
    if (!session) return next(new HttpError(401, 'unauthorized', 'Access token is invalid, expired or revoked'))

    req.headers[CALLER_HEADER] = `Bearer ${session}`
    res.locals[VIA_ACCESS_TOKEN] = true
    next()
  }

  /** Os tokens de acesso da própria conta. Nunca o token: só nome, prefixo e datas. */
  async listTokens(_req: Request, res: Response) {
    await this.respond(res, async () => this.tokens.list(await this.requireSelf()).map(toTokenDto))
  }

  /** ⛔ Só por sessão (login): um token de acesso não cria outro — um vazado não se multiplica. */
  async createToken(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = await this.requireSession(res)
        const body = parseBody(createAccessTokenSchema, req.body)
        const created = this.tokens.create(id, body)
        return { token: created.token, ...toTokenDto(created.accessToken) }
      },
      { status: 201, message: 'Access token created. Copy it now: it is not shown again.' },
    )
  }

  async revokeToken(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        this.tokens.revoke(await this.requireSession(res), req.params.id as string)
        return null
      },
      { message: 'Access token revoked' },
    )
  }

  /** Público: a tela pergunta se precisa mostrar o setup. Só isso — nada sobre quem são as contas. */
  async status(_req: Request, res: Response) {
    await this.respond(res, async () => ({ localAccounts: !!this.deps.accounts, setupRequired: this.deps.accounts?.setupRequired() ?? false }))
  }

  async setup(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const body = parseBody(setupSchema, req.body)
        return toSessionDto(this.accounts.setup(body, isLoopback(req)))
      },
      { status: 201, message: 'Administrator created' },
    )
  }

  async login(req: Request, res: Response) {
    await this.respond(res, async () => {
      const body = parseBody(loginSchema, req.body)
      return toSessionDto(this.accounts.login(body.email, body.password))
    })
  }

  /** Sai de todas as sessões da conta. Depois disto, nenhum token emitido antes vale. */
  async logout(_req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        this.accounts.logout(await this.requireSelf())
        return null
      },
      { message: 'Signed out' },
    )
  }

  /** A conta da sessão. Token de fora (prova externa) não tem conta aqui: 404. */
  async me(_req: Request, res: Response) {
    await this.respond(res, async () => toUserDto(this.accounts.me(await this.requireSelf())))
  }

  async changePassword(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const id = await this.requireSelf()
        const body = parseBody(changePasswordSchema, req.body)
        // Volta a sessão nova: esta continua, as outras caem.
        return toSessionDto(this.accounts.changeOwnPassword(id, body.current, body.password))
      },
      { message: 'Password changed' },
    )
  }

  async listUsers(_req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('listUsers')
      return this.accounts.list().map(toUserDto)
    })
  }

  async createUser(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('createUser')
        const body = parseBody(createUserSchema, req.body)
        return toUserDto(this.accounts.create(body, admin.by))
      },
      { status: 201, message: 'User created' },
    )
  }

  async updateUser(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('updateUser')
        const body = parseBody(updateUserSchema, req.body)
        return toUserDto(this.accounts.update(req.params.id as string, body, admin.id, admin.by))
      },
      { message: 'User updated' },
    )
  }

  async resetPassword(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('resetPassword')
        const body = parseBody(resetPasswordSchema, req.body)
        this.accounts.resetPassword(req.params.id as string, body.password, admin.by)
        return null
      },
      { message: 'Password reset' },
    )
  }

  async revokeSessions(req: Request, res: Response) {
    await this.respond(
      res,
      async () => {
        const admin = await this.requireAdmin('revokeSessions')
        this.accounts.revokeSessions(req.params.id as string, admin.by)
        return null
      },
      { message: 'Sessions ended' },
    )
  }

  private get accounts(): AccountsService {
    if (!this.deps.accounts) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.accounts
  }

  private get tokens(): AccessTokensService {
    if (!this.deps.accessTokens) throw new HttpError(404, 'not_found', 'Local accounts are disabled')
    return this.deps.accessTokens
  }

  /** A conta, provada E logada por sessão — não por token de acesso. */
  private async requireSession(res: Response): Promise<string> {
    const id = await this.requireSelf()
    if (res.locals[VIA_ACCESS_TOKEN]) throw new HttpError(403, 'forbidden', 'Sign in to manage access tokens; an access token cannot manage tokens')
    return id
  }

  private async requireSelf(): Promise<string> {
    const identity = await provenCaller(this.deps.proof)
    if (!identity?.id) throw new HttpError(401, 'unauthorized', 'Missing or unverifiable caller credential')
    return identity.id
  }

  /** Mesma porta das outras telas de operação: admin provado, ou 404. */
  private async requireAdmin(operation: string): Promise<{ id: string; by: string }> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed || !access.identity?.id) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
    return { id: access.identity.id, by: access.identity.email ?? access.identity.id }
  }

  private async respond<T>(res: Response, work: () => Promise<T>, options: { status?: number; message?: string } = {}) {
    try {
      res.status(options.status ?? 200).json(ok(await work(), options.message))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[AuthController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** Lista explícita: o hash nunca sai, e campo novo na conta nasce privado. */
function toUserDto(user: IUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    updatedBy: user.updatedBy,
    lastLoginAt: user.lastLoginAt,
  }
}

/** Lista explícita: o hash nunca sai. */
function toTokenDto(token: IAccessToken) {
  return { id: token.id, name: token.name, prefix: token.prefix, createdAt: token.createdAt, expiresAt: token.expiresAt, lastUsedAt: token.lastUsedAt, revokedAt: token.revokedAt }
}

function toSessionDto(session: ISession) {
  return { token: session.token, expiresAt: session.expiresAt, user: toUserDto(session.user) }
}
