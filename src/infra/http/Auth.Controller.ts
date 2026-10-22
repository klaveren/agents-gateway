import { AccountsService, ISession } from '@application/Accounts.Service'
import { IUser } from '@domain/models/User.Model'
import { Request, Response } from 'express'
import { provenCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { parseBody } from './Request.Parser'
import { changePasswordSchema, createUserSchema, loginSchema, resetPasswordSchema, setupSchema, updateUserSchema } from './Request.Schema'

export interface IAuthControllerDeps {
  /** Ausente = sem contas locais (`CONVERSATIONS_DB=off`): as rotas respondem 404, o status diz que não há. */
  accounts?: AccountsService
  proof?: ICallerProof
}

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
    for (const name of ['status', 'setup', 'login', 'me', 'changePassword', 'listUsers', 'createUser', 'updateUser', 'resetPassword'] as const) {
      this[name] = this[name].bind(this)
    }
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
        this.accounts.changeOwnPassword(id, body.current, body.password)
        return null
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

  private get accounts(): AccountsService {
    if (!this.deps.accounts) throw new HttpError(404, 'not_found', 'Not found')
    return this.deps.accounts
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

function toSessionDto(session: ISession) {
  return { token: session.token, expiresAt: session.expiresAt, user: toUserDto(session.user) }
}
