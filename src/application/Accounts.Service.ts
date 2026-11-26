import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { InvalidCredentialsError, InvalidUserError, LoginLockedError, SessionNotFoundError, SetupUnavailableError, UserNotFoundError } from '@domain/errors/Domain.Error'
import { keepSignedInTtlMs, sessionRenewIntervalMs } from '@domain/LoginSession.Policy'
import { ILoginSession } from '@domain/models/LoginSession.Model'
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

/** Como a sessão nasce: "Manter conectado" e o aparelho (já resumido do user-agent). */
export interface ISessionStart {
  keep?: boolean
  device?: string
}

/** As durações da sessão de login (ver `LoginSession.Policy`). */
export interface ISessionDurations {
  /** A validade do "Manter conectado", que volta a valer inteira a cada renovação. */
  keepTtlMs: number
  /** Renova no máximo uma vez neste intervalo. */
  renewAfterMs: number
}

/** O último uso é anotado no máximo uma vez por minuto: a lista não precisa de mais, e o banco não grava a cada pedido. */
const TOUCH_GAP_MS = 60_000

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
  /** O que nasce junto com o primeiro admin (o projeto inicial; ver `Projects.Factory`). Ligado depois: os projetos dependem das contas. */
  private setupHooks: Array<(user: IUser) => void> = []
  private createHooks: Array<(user: IUser, by: string) => void> = []

  constructor(
    private readonly users: IUserRepository,
    private readonly hasher: IPasswordHasher,
    private readonly tokens: ITokenIssuer,
    private readonly now: () => number = Date.now,
    setupCode: string = process.env.SETUP_CODE?.trim() || newSetupCode(),
    private readonly durations: ISessionDurations = { keepTtlMs: keepSignedInTtlMs(), renewAfterMs: sessionRenewIntervalMs() },
  ) {
    this.decoy = hasher.hash(randomBytes(16).toString('hex'))
    this.setupCode = setupCode
  }

  /** Roda depois de criar o primeiro admin, antes de devolver a sessão. */
  afterSetup(hook: (user: IUser) => void): void {
    this.setupHooks.push(hook)
  }

  /** Roda depois de o admin criar uma conta (não no setup). */
  afterCreate(hook: (user: IUser, by: string) => void): void {
    this.createHooks.push(hook)
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
  setup(input: Omit<INewUser, 'role'>, code: string | undefined, start: ISessionStart = {}): ISession {
    if (!this.setupRequired() || !sameCode(code, this.setupCode)) throw new SetupUnavailableError()

    const user = this.insert({ ...input, role: 'admin' }, 'setup')
    for (const hook of this.setupHooks) hook(user)
    // O setup já entra: conta como o primeiro acesso.
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.openSession(user.id, start)
  }

  /**
   * ⚠️ ASSÍNCRONO: o scrypt custa dezenas de milissegundos de CPU, e a versão síncrona travava o processo
   * inteiro (todas as rotas, todos os streams) enquanto alguém disparava logins em paralelo.
   */
  async login(email: string, password: string, origin = '', start: ISessionStart = {}): Promise<ISession> {
    const user = this.users.findByEmail(normalizeEmail(email))
    const key = `${normalizeEmail(email)}\u0000${origin}`
    this.reserveAttempt(key)

    // A conferência roda SEMPRE, contra o hash falso quando não há conta: o tempo da resposta não
    // pode contar se o e-mail existe.
    const hash = user?.passwordHash ?? this.decoy
    const matches = this.hasher.verifyAsync ? await this.hasher.verifyAsync(password, hash) : this.hasher.verify(password, hash)

    // A tentativa já foi contada (`reserveAttempt`): errar não grava nada de novo.
    if (!user || user.disabled || !matches) throw new InvalidCredentialsError()

    this.failures.delete(key)
    this.users.update(user.id, { lastLoginAt: new Date(this.now()) })
    return this.openSession(user.id, start)
  }

  /**
   * ⛔ CONTA A TENTATIVA ANTES do `await` do scrypt. Lida depois, o estado era o de antes de todas as tentativas em
   * paralelo: 30 de uma vez gravavam `count=1` e a trava nunca fechava. Acertar zera (`failures.delete`).
   */
  private reserveAttempt(key: string): void {
    const state = this.failures.get(key)
    if (state?.lockedUntil && state.lockedUntil > this.now()) throw new LoginLockedError(Math.ceil((state.lockedUntil - this.now()) / 1000))
    const count = (state?.lockedUntil && state.lockedUntil <= this.now() ? 0 : (state?.count ?? 0)) + 1
    this.trackFailure(key, { count, lockedUntil: count >= LOCK_AFTER_FAILURES ? this.now() + LOCK_MS : undefined })
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
    const user = this.insert(input, by)
    for (const hook of this.createHooks) hook(user, by)
    return user
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
  async changeOwnPassword(id: string, current: string, next: string, origin = '', token?: string): Promise<ISession> {
    // ⛔ Mesma trava de falhas do login (por conta e origem) e scrypt assíncrono: a rota é um oráculo de senha para quem roubou a sessão.
    const key = `password\u0000${id}\u0000${origin}`
    this.reserveAttempt(key)
    const user = this.users.findById(id)
    const matches = user ? (this.hasher.verifyAsync ? await this.hasher.verifyAsync(current, user.passwordHash) : this.hasher.verify(current, user.passwordHash)) : false
    if (!user || !matches) throw new InvalidUserError([{ field: 'current', message: 'current password does not match' }])
    this.failures.delete(key)
    // A sessão desta tela continua como era ("Manter conectado" e aparelho), já na geração nova.
    const was = this.ownSession(id, token)
    this.setPassword(id, next, user.email)
    return this.openSession(id, { keep: was?.keep, device: was?.device })
  }

  /**
   * Sai DESTE navegador: encerra só a sessão do token apresentado. Token de antes (sem sessão própria) não dá para
   * encerrar sozinho: aí saem todas, como antes. `all`: sai de todos os aparelhos.
   * ⚖️ Turno que já roda vai até o fim mesmo assim (`Live.TurnTokens`); os próximos pedem login de novo.
   */
  logout(id: string, token?: string, all = false): void {
    const claims = token ? this.tokens.verify(token) : undefined
    if (!all && claims?.sub === id && claims.sid) return this.endSessionById(claims.sid, new Date(claims.exp * 1000))
    this.revoke(id)
  }

  /**
   * As sessões de login abertas da conta (aparelho, último uso), com `current` na desta tela. Só as da geração de agora:
   * as de antes de sair de todos ou de trocar a senha já caíram.
   */
  listSessions(id: string, token?: string): Array<ILoginSession & { current: boolean }> {
    const user = this.users.findById(id)
    if (!user) throw new UserNotFoundError(id)
    const current = this.tokens.verify(token ?? '')?.sid
    return this.users
      .listSessions(id, new Date(this.now()))
      .filter((session) => session.ver === user.sessionVersion && !this.users.sessionRevoked(session.id))
      .map((session) => ({ ...session, current: session.id === current }))
  }

  /** Encerra UMA sessão da conta (outro aparelho). Sessão de outra conta é a mesma recusa de inexistente. */
  endSession(id: string, sid: string): void {
    const session = this.users.findSession(sid)
    if (!session || session.userId !== id) throw new SessionNotFoundError(sid)
    this.endSessionById(sid)
  }

  /**
   * Encerra todas as OUTRAS sessões: avança a geração (cai tudo, inclusive cópias e sessões de antes da lista existir) e
   * devolve esta mesma sessão (mesmo `sid`, mesmo "Manter conectado") já na geração nova.
   */
  endOtherSessions(id: string, token?: string): ISession {
    const claims = this.tokens.verify(token ?? '')
    if (!claims || claims.sub !== id || !claims.sid || claims.via) throw new SessionNotFoundError('current')
    const was = this.users.findSession(claims.sid)
    this.revoke(id)
    return this.openSession(id, { keep: claims.keep, device: was?.device }, { sid: claims.sid, createdAt: was?.createdAt })
  }

  /**
   * A cada pedido da tela (cookie): anota o último uso e, no "Manter conectado", RENOVA — mais 30 dias a partir de agora,
   * no máximo uma vez por hora. Devolve a sessão nova só quando renovou.
   *
   * ⛔ Só renova o que a prova aceitaria agora: sessão de login (não a derivada de `agw_`), da conta ativa, com o mesmo
   * e-mail e papel, da geração de agora, não encerrada e ainda listada. Vencida não chega aqui (a assinatura e o prazo
   * já recusam). Encerrar apaga a linha: cópia antiga do token não renova.
   */
  keepAlive(token: string): ISession | undefined {
    const claims = this.tokens.verify(token)
    if (!claims?.sid || claims.via) return undefined
    const session = this.users.findSession(claims.sid)
    if (!session || session.userId !== claims.sub) return undefined
    const user = this.users.findById(claims.sub)
    if (!user || user.disabled || user.email !== claims.email || user.role !== claims.role) return undefined
    if (user.sessionVersion !== claims.ver || session.ver !== claims.ver || this.users.sessionRevoked(claims.sid)) return undefined

    const now = this.now()
    this.users.touchSession(claims.sid, new Date(now), TOUCH_GAP_MS)
    if (!claims.keep || now - claims.iat * 1000 < this.durations.renewAfterMs) return undefined
    return this.openSession(user.id, { keep: true, device: session.device }, { sid: claims.sid, createdAt: session.createdAt })
  }

  /**
   * ⚖️ A revogação vale até o token MAIS NOVO desta sessão vencer (o da linha, que a renovação empurra), e a linha sai:
   * uma cópia antiga do token não volta a renovar.
   */
  private endSessionById(sid: string, tokenExpiry = new Date(0)): void {
    const session = this.users.findSession(sid)
    const until = new Date(Math.max(tokenExpiry.getTime(), session?.expiresAt.getTime() ?? 0, this.now() + this.durations.keepTtlMs))
    this.users.revokeSession(sid, until)
    this.users.deleteSession(sid)
  }

  /** O token é da sessão `sid`? (Encerrar a própria sessão pela lista também limpa o cookie.) */
  isSessionOf(token: string | undefined, sid: string): boolean {
    return !!token && this.tokens.verify(token)?.sid === sid
  }

  /** A sessão de login deste token, se for desta conta. */
  private ownSession(id: string, token?: string): ILoginSession | undefined {
    const sid = this.tokens.verify(token ?? '')?.sid
    const session = sid ? this.users.findSession(sid) : undefined
    return session?.userId === id ? session : undefined
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

  /**
   * Uma sessão da conta SEM senha — a de um hook, que roda em nome de quem o criou. `undefined` se a conta
   * não existe mais ou está desativada: o hook para junto com ela.
   */
  sessionForHook(id: string): ISession | undefined {
    const user = this.users.findById(id)
    if (!user || user.disabled) return undefined
    return this.sessionFor(id)
  }

  /** Quando um token de sessão DESTE gateway vence — `undefined` para o que não é dele ou não vale. */
  expiryOf(token: string): Date | undefined {
    const claims = this.tokens.verify(token)
    return claims ? new Date(claims.exp * 1000) : undefined
  }

  private sessionFor(id: string): ISession {
    const user = this.me(id)
    const ver = this.users.findById(id)?.sessionVersion ?? 0
    const { token, expiresAt } = this.tokens.issue({ sub: user.id, email: user.email, role: user.role, ver, sid: randomBytes(12).toString('base64url') })

    return { token, expiresAt, user }
  }

  /**
   * A sessão de LOGIN de pessoa: emite o token (30 dias no "Manter conectado"; o de sempre sem ele) e grava a linha que a
   * lista "Sessões abertas" mostra. `keep.sid`: renova a mesma sessão em vez de abrir outra.
   */
  private openSession(id: string, start: ISessionStart, same?: { sid: string; createdAt?: Date }): ISession {
    const user = this.me(id)
    const ver = this.users.findById(id)?.sessionVersion ?? 0
    const keep = start.keep === true
    const sid = same?.sid ?? randomBytes(12).toString('base64url')
    const { token, expiresAt } = this.tokens.issue(
      { sub: user.id, email: user.email, role: user.role, ver, sid, ...(keep ? { keep } : {}) },
      keep ? this.durations.keepTtlMs : undefined,
    )
    const now = new Date(this.now())
    this.users.saveSession({ id: sid, userId: user.id, ver, keep, device: start.device ?? 'Desconhecido', createdAt: same?.createdAt ?? now, lastUsedAt: now, expiresAt })

    return { token, expiresAt, user }
  }
}
