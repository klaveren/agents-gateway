import { TUserRole } from '@domain/models/User.Model'

export interface ISessionClaims {
  sub: string
  email: string
  role: TUserRole
  /** A geração da sessão (`IStoredUser.sessionVersion`) em que o token nasceu. */
  ver: number
  /**
   * ⛔ A marca de sessão DERIVADA de token de acesso (`agw_`): `via: 'agw'` e `tid` = o id do token. Esta sessão não
   * gere tokens, não vira cookie e não vale como "pessoa na tela"; e cai junto com o `agw_` de origem.
   */
  via?: 'agw'
  tid?: string
}

/** Emite e confere o token da sessão. Conferir é só a assinatura e o prazo — a conta é com a prova. */
export interface ITokenIssuer {
  issue(claims: ISessionClaims): { token: string; expiresAt: Date }
  verify(token: string): (ISessionClaims & { exp: number }) | undefined
  /** O token é deste emissor? Decide se a prova local responde por ele, sem conferir nada. */
  owns(token: string): boolean
}
