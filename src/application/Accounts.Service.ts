import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { InvalidCredentialsError, InvalidUserError, LoginLockedError, SetupUnavailableError, UserNotFoundError } from '@domain/errors/Domain.Error'
import { IUser, TUserRole, toUser } from '@domain/models/User.Model'
import { IPasswordHasher } from '@domain/ports/PasswordHasher.Port'
import { ITokenIssuer } from '@domain/ports/TokenIssuer.Port'
import { IUserRepository } from '@domain/ports/UserRepository.Port'
import { newUserIssues, normalizeEmail, passwordIssue, userChangeIssues } from '@domain/User.Policy'

export const LOCK_AFTER_FAILURES = 5
export const LOCK_MS = 15 * 60_000
/** Teto do mapa de falhas: um e-mail inventado por pedido não pode crescer a memória sem fim. */
const MAX_TRACKED_FAILURES = 10_000

/** O código de instalação: 12 caracteres em três grupos (`AB12-CD34-EF56`). */
function newSetupCode(): string {
  return (randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g) ?? []).join('-')
}

function sameCode(given: string | undefined, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value.trim().toUpperCase()).digest()
  return !!given && timingSafeEqual(digest(given), digest(expected))
}

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
 * ⛔ A TRAVA DE FORÇA BRUTA é por e-mail E ORIGEM, em memória: cinco falhas seguidas da mesma origem
 * fecham aquele e-mail para ela por 15 minutos, exista a conta ou não (responder diferente contaria quais
 * existem). Por origem para que ninguém de fora tranque o admin legítimo; o limite por IP da porta
 * (`rateLimit`) segura quem troca de e-mail a cada tentativa. Restart zera.
 */
export class AccountsService {
  private readonly failures = new Map<string, { count: number; lockedUntil?: number }>()
  /** Hash de uma senha qualquer: o login sem conta paga o MESMO custo do login com conta. */
  private readonly decoy: string
  /**
   * ⛔ O CÓDIGO DE INSTALAÇÃO do primeiro admin: gerado no boot (ou `SETUP_CODE`), impresso no log do
   * servidor, obrigatório no setup. Quem lê o log é quem opera a máquina — e não "quem chega primeiro".
   */
  readonly setupCode: string

  constructor(
    private readonly users: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokenIssuer,
    private readonly now: () => number = Date.now,
    setupCode: string = process.env.SETUP_CODE?.trim() || newSetupCode(),
  ) {
    this.decoy = hasher.hash(randomBytes(16).toString('hex'))
    this.setupCode = setupCode
  }

  setupRequired(): boolean {
    return this.users.count() === 0
  }

  /**
   * O primeiro admin.
   *
   * ⛔ SÓ COM ZERO CONTAS E COM O CÓDIGO DO LOG: sem isso, o primeiro a abrir a tela de um gateway
   * recém-instalado e exposto viraria dono dele. Antes a prova era "veio de loopback" — e um proxy na
   * mesma máquina que não põe `X-Forwarded-For` entregava o admin a qualquer um.
   */
  setup(input: Omit<INewUser, 'role'>, code: string | undefined): ISession {
    if (!this.setupRequired() || !sameCode(code, this.setupCode)) throw new SetupUnavailableError()

    const user = this.insert({ ...input, role: 'admin' }, 'setup')
    // O setup já entra: conta como o primeiro acesso.
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.sessionFor(user.id)
  }

  /**
   * ⚠️ ASSÍNCRONO: o scrypt custa dezenas de milissegundos de CPU, e a versão síncrona travava o processo
   * inteiro (todas as rotas, todos os streams) enquanto alguém disparava logins em paralelo.
   */
  async login(email: string, password: string, origin = ''): Promise<ISession> {
    const user = this.users.findByEmail(normalizeEmail(email))
    const key = `${normalizeEmail(email)}\u0000${origin}`
    const state = this.failures.get(key)
    if (state?.lockedUntil && state.lockedUntil > this.now()) throw new LoginLockedError(Math.ceil((state.lockedUntil - this.now()) / 1000))

    // A conferência roda SEMPRE, contra o hash falso quando não há conta: o tempo da resposta não
    // pode contar se o e-mail existe.
    const hash = user?.passwordHash ?? this.decoy
    const matches = this.hasher.verifyAsync ? await this.hasher.verifyAsync(password, hash) : this.hasher.verify(password, hash)

    if (!user || user.disabled || !matches) {
      const count = (state?.lockedUntil && state.lockedUntil <= this.now() ? 0 : (state?.count ?? 0)) + 1
      this.trackFailure(key, { count, lockedUntil: count >= LOCK_AFTER_FAILURES ? this.now() + LOCK_MS : undefined })
      throw new InvalidCredentialsError()
    }

    this.failures.delete(key)
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.sessionFor(user.id)
  }

  /** Com teto: no limite, saem primeiro as travas vencidas, e depois as mais antigas. */
  private trackFailure(key: string, state: { count: number; lockedUntil?: number }) {
    this.failures.delete(key)
    this.failures.set(key, state)
    if (this.failures.size <= MAX_TRACKED_FAILURES) return
    for (const [entry, value] of this.failures) if (!value.lockedUntil || value.lockedUntil <= this.now()) this.failures.delete(entry)
    while (this.failures.size > MAX_TRACKED_FAILURES) this.failures.delete(this.failures.keys().next().value as string)
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

  /** O admin define a senha de outra conta (esquecida, ou a inicial). As sessões dela caem. */
  resetPassword(id: string, password: string, by: string): void {
    if (!this.users.findById(id)) throw new UserNotFoundError(id)
    this.setPassword(id, password, by)
  }

  /**
   * A própria senha: exige a atual, para quem achar a sessão aberta não trancar o dono fora.
   *
   * ⚖️ As OUTRAS sessões caem (quem troca a senha por desconfiar de alguém quer exatamente isso), e
   * esta continua: volta uma sessão nova, já na geração nova.
   */
  changeOwnPassword(id: string, current: string, next: string): ISession {
    const user = this.users.findById(id)
    if (!user || !this.hasher.verify(current, user.passwordHash)) throw new InvalidUserError([{ field: 'current', message: 'current password does not match' }])
    this.setPassword(id, next, user.email)
    return this.sessionFor(id)
  }

  /** Sair: encerra TODAS as sessões da conta, não só a deste navegador — uma cópia do token não sobra. */
  logout(id: string): void {
    this.revoke(id)
  }

  /** O admin encerra as sessões de uma conta (aparelho perdido, acesso que deveria ter acabado). */
  revokeSessions(id: string, by: string): void {
    if (!this.users.findById(id)) throw new UserNotFoundError(id)
    this.revoke(id, by)
  }

  private revoke(id: string, by?: string): void {
    const user = this.users.findById(id)
    if (!user) return
    this.users.update(id, { sessionVersion: user.sessionVersion + 1, ...(by ? { updatedAt: new Date(this.now()), updatedBy: by } : {}) })
  }

  private setPassword(id: string, password: string, by: string): void {
    const issue = passwordIssue(password)
    if (issue) throw new InvalidUserError([{ field: 'password', message: issue }])

    const user = this.users.findById(id)
    this.users.update(id, { passwordHash: this.hasher.hash(password), sessionVersion: (user?.sessionVersion ?? 0) + 1, updatedAt: new Date(this.now()), updatedBy: by })
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
      sessionVersion: 0,
    }
    this.users.insert(stored)

    return toUser(stored)
  }

  /** Quando um token de sessão DESTE gateway vence — `undefined` para o que não é dele ou não vale. */
  expiryOf(token: string): Date | undefined {
    const claims = this.tokens.verify(token)
    return claims ? new Date(claims.exp * 1000) : undefined
  }

  private sessionFor(id: string): ISession {
    const user = this.me(id)
    const ver = this.users.findById(id)?.sessionVersion ?? 0
    const { token, expiresAt } = this.tokens.issue({ sub: user.id, email: user.email, role: user.role, ver })

    return { token, expiresAt, user }
  }
}
