export const USER_ROLES = ['admin', 'member'] as const
export type TUserRole = (typeof USER_ROLES)[number]

/**
 * Uma conta do gateway.
 *
 * ⚖️ `role` É O PAPEL, e é ele que vai no token: `admin` abre as telas de operação (agentes,
 * usuários, configuração) pela mesma regra de sempre (`checkAdminAccess` + `ADMIN_ROLES`).
 */
export interface IUser {
  id: string
  /** Sempre em minúsculas (ver `normalizeEmail`): é a chave do login. */
  email: string
  name: string
  role: TUserRole
  /** Desativada não entra, e o token que ela já tinha deixa de valer na hora (ver `LocalCallerProof`). */
  disabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
  lastLoginAt?: Date
}

/** O registro gravado. ⛔ O hash nunca sai do servidor: a API devolve `IUser`. */
export interface IStoredUser extends IUser {
  passwordHash: string
}

export function toUser(stored: IStoredUser): IUser {
  return {
    id: stored.id,
    email: stored.email,
    name: stored.name,
    role: stored.role,
    disabled: stored.disabled,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
    lastLoginAt: stored.lastLoginAt,
  }
}
