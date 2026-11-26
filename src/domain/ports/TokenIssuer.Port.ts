import { TUserRole } from '@domain/models/User.Model'

export interface ISessionClaims {
  sub: string
  email: string
  role: TUserRole
  /** A geração da sessão (`IStoredUser.sessionVersion`) em que o token nasceu. */
  ver: number
  /** A sessão deste login (um navegador): sair encerra só ela. Ausente nos tokens de antes. */
  sid?: string
  /**
   * ⛔ A marca de sessão DERIVADA de token de acesso (`agw_`): `via: 'agw'` e `tid` = o id do token. Esta sessão não
   * gere tokens, não vira cookie e não vale como "pessoa na tela"; e cai junto com o `agw_` de origem.
   */
  via?: 'agw'
  tid?: string
  /** "Manter conectado": a sessão de login que dura 30 dias e desliza com o uso. ⛔ Nunca junto com `via`. */
  keep?: boolean
}

/** Emite e confere o token da sessão. Conferir é só a assinatura e o prazo — a conta é com a prova. */
export interface ITokenIssuer {
  /** `ttlMs`: a validade deste token (o "Manter conectado"); ausente, a de sempre. */
  issue(claims: ISessionClaims, ttlMs?: number): { token: string; expiresAt: Date }
  /** `iat`: quando o token nasceu (segundos) — decide se já é hora de renovar. */
  verify(token: string): (ISessionClaims & { exp: number; iat: number }) | undefined
  /** O token é deste emissor? Decide se a prova local responde por ele, sem conferir nada. */
  owns(token: string): boolean
}
