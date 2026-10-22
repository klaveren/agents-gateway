import { randomBytes } from 'node:crypto'
import { InvalidCredentialsError, InvalidUserError, LoginLockedError, SetupUnavailableError, UserNotFoundError } from '@domain/errors/Domain.Error'
import { IUser, TUserRole, toUser } from '@domain/models/User.Model'
import { IPasswordHasher } from '@domain/ports/PasswordHasher.Port'
import { ITokenIssuer } from '@domain/ports/TokenIssuer.Port'
import { IUserRepository } from '@domain/ports/UserRepository.Port'
import { newUserIssues, normalizeEmail, passwordIssue, userChangeIssues } from '@domain/User.Policy'

export const LOCK_AFTER_FAILURES = 5
export const LOCK_MS = 15 * 60_000

export interface ISession {
  token: string
  expiresAt: Date
  user: IUser
}

export interface INewUser {
  email: string
  name: string
  password: string
  role: TUserRole
}

/**
 * As contas do gateway: o primeiro admin, o login, e o que o admin faz com as contas dos outros.
 *
 * ⛔ A TRAVA DE FORÇA BRUTA é por e-mail e EM MEMÓRIA: cinco falhas seguidas fecham o e-mail por 15
 * minutos, exista a conta ou não (responder diferente contaria quais existem). Restart zera — é uma
 * trava contra tentativa automática, não um registro de auditoria.
 */
export class AccountsService {
  private readonly failures = new Map<string, { count: number; lockedUntil?: number }>()
  /** Hash de uma senha qualquer: o login sem conta paga o MESMO custo do login com conta. */
  private readonly decoy: string

  constructor(
    private readonly users: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokenIssuer,
    private readonly now: () => number = Date.now,
  ) {
    this.decoy = hasher.hash(randomBytes(16).toString('hex'))
  }

  setupRequired(): boolean {
    return this.users.count() === 0
  }

  /**
   * O primeiro admin.
   *
   * ⛔ SÓ COM ZERO CONTAS E SÓ DESTA MÁQUINA (`fromLoopback`, decidido no transporte): sem isso, o
   * primeiro a abrir a tela de um gateway recém-instalado e exposto viraria dono dele.
   */
  setup(input: Omit<INewUser, 'role'>, fromLoopback: boolean): ISession {
    if (!fromLoopback || !this.setupRequired()) throw new SetupUnavailableError()

    const user = this.insert({ ...input, role: 'admin' }, 'setup')
    // O setup já entra: conta como o primeiro acesso.
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.sessionFor(user.id)
  }

  login(email: string, password: string): ISession {
    const key = normalizeEmail(email)
    const state = this.failures.get(key)
    if (state?.lockedUntil && state.lockedUntil > this.now()) throw new LoginLockedError(Math.ceil((state.lockedUntil - this.now()) / 1000))

    const user = this.users.findByEmail(key)
    // A conferência roda SEMPRE, contra o hash falso quando não há conta: o tempo da resposta não
    // pode contar se o e-mail existe.
    const matches = this.hasher.verify(password, user?.passwordHash ?? this.decoy)

    if (!user || user.disabled || !matches) {
      const count = (state?.lockedUntil && state.lockedUntil <= this.now() ? 0 : (state?.count ?? 0)) + 1
      this.failures.set(key, { count, lockedUntil: count >= LOCK_AFTER_FAILURES ? this.now() + LOCK_MS : undefined })
      throw new InvalidCredentialsError()
    }

    this.failures.delete(key)
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.sessionFor(user.id)
  }

  me(id: string): IUser {
    const user = this.users.findById(id)
    if (!user || user.disabled) throw new UserNotFoundError(id)
    return toUser(user)
  }

  list(): IUser[] {
    return this.users.list().map(toUser)
  }

  create(input: INewUser, by: string): IUser {
    return this.insert(input, by)
  }

  update(id: string, change: { name?: string; role?: TUserRole; disabled?: boolean }, actorId: string, by: string): IUser {
    const target = this.users.findById(id)
    if (!target) throw new UserNotFoundError(id)

    const issues = userChangeIssues(toUser(target), change, actorId, this.list())
    if (change.name !== undefined && !change.name.trim()) issues.push({ field: 'name', message: 'required' })
    if (issues.length) throw new InvalidUserError(issues)

    const updated = this.users.update(id, { ...change, name: change.name?.trim(), updatedAt: new Date(this.now()), updatedBy: by })
    return toUser(updated as NonNullable<typeof updated>)
  }

  /** O admin define a senha de outra conta (esquecida, ou a inicial). */
  resetPassword(id: string, password: string, by: string): void {
    if (!this.users.findById(id)) throw new UserNotFoundError(id)
    this.setPassword(id, password, by)
  }

  /** A própria senha: exige a atual, para quem achar a sessão aberta não trancar o dono fora. */
  changeOwnPassword(id: string, current: string, next: string): void {
    const user = this.users.findById(id)
    if (!user || !this.hasher.verify(current, user.passwordHash)) throw new InvalidUserError([{ field: 'current', message: 'current password does not match' }])
    this.setPassword(id, next, user.email)
  }

  private setPassword(id: string, password: string, by: string): void {
    const issue = passwordIssue(password)
    if (issue) throw new InvalidUserError([{ field: 'password', message: issue }])
    this.users.update(id, { passwordHash: this.hasher.hash(password), updatedAt: new Date(this.now()), updatedBy: by })
  }

  private insert(input: INewUser, by: string): IUser {
    const issues = newUserIssues(input, this.list())
    if (issues.length) throw new InvalidUserError(issues)

    const now = new Date(this.now())
    const stored = {
      id: `u_${randomBytes(9).toString('base64url')}`,
      email: normalizeEmail(input.email),
      name: input.name.trim(),
      role: input.role,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      updatedBy: by,
      passwordHash: this.hasher.hash(input.password),
    }
    this.users.insert(stored)

    return toUser(stored)
  }

  private sessionFor(id: string): ISession {
    const user = this.me(id)
    const { token, expiresAt } = this.tokens.issue({ sub: user.id, email: user.email, role: user.role })

    return { token, expiresAt, user }
  }
}
