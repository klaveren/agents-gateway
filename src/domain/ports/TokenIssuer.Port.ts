import { TUserRole } from '@domain/models/User.Model'

export interface ISessionClaims {
  sub: string
  email: string
  role: TUserRole
  /** A geração da sessão (`IStoredUser.sessionVersion`) em que o token nasceu. */
  ver: number
}

/** Emite e confere o token da sessão. Conferir é só a assinatura e o prazo — a conta é com a prova. */
export interface ITokenIssuer {
  issue(claims: ISessionClaims): { token: string; expiresAt: Date }
  verify(token: string): (ISessionClaims & { exp: number }) | undefined
  /** O token é deste emissor? Decide se a prova local responde por ele, sem conferir nada. */
  owns(token: string): boolean
}
