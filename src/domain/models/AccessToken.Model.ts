/**
 * Um token de acesso pessoal: o que um script, o Claude Code ou outro cliente MCP usa no lugar do login.
 *
 * ⚖️ AGE COMO A CONTA, não como um papel próprio: tirar o admin da conta rebaixa o token; desativar a
 * conta o derruba. E é INDEPENDENTE das sessões — "Sair" e a troca de senha não o revogam; revoga-se na lista.
 */
export interface IAccessToken {
  id: string
  userId: string
  name: string
  /** O começo do token (`agw_AbCd`), para reconhecê-lo na lista. O resto nunca volta. */
  prefix: string
  createdAt: Date
  expiresAt?: Date
  lastUsedAt?: Date
  revokedAt?: Date
}

/** ⛔ Só o hash é gravado: com o banco nas mãos, ninguém usa os tokens. */
export interface IStoredAccessToken extends IAccessToken {
  tokenHash: string
}

export const ACCESS_TOKEN_PREFIX = 'agw_'
export const ACCESS_TOKEN_NAME_MAX = 60
export const ACCESS_TOKENS_PER_USER = 20
export const ACCESS_TOKEN_MAX_DAYS = 365

export function isAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX)
}
