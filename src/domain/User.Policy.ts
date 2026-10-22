import { IUser, TUserRole, USER_ROLES } from './models/User.Model'

export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 200
export const USER_NAME_MAX = 80
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface IUserIssue {
  field: string
  message: string
}

/** O e-mail é a chave do login: `Ana@X.com` e `ana@x.com` são a mesma conta. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * ⚖️ SÓ COMPRIMENTO, sem regra de "um símbolo e uma maiúscula": a regra de composição empurra para
 * `Senha123!`, e o que pesa contra força bruta é o tamanho. O teto existe porque o hash custa CPU por
 * caractere — uma senha de 1 MB seria um jeito barato de ocupar o servidor.
 */
export function passwordIssue(password: string): string | undefined {
  if (password.length < PASSWORD_MIN) return `at least ${PASSWORD_MIN} characters`
  if (password.length > PASSWORD_MAX) return `at most ${PASSWORD_MAX} characters`
  return undefined
}

export function newUserIssues(input: { email: string; name: string; password: string; role: string }, existing: readonly IUser[]): IUserIssue[] {
  const issues: IUserIssue[] = []
  const email = normalizeEmail(input.email)

  if (!EMAIL_PATTERN.test(email)) issues.push({ field: 'email', message: 'invalid e-mail' })
  else if (existing.some((user) => user.email === email)) issues.push({ field: 'email', message: 'already registered' })

  if (!input.name.trim()) issues.push({ field: 'name', message: 'required' })
  else if (input.name.length > USER_NAME_MAX) issues.push({ field: 'name', message: `at most ${USER_NAME_MAX} characters` })

  if (!USER_ROLES.includes(input.role as TUserRole)) issues.push({ field: 'role', message: `unknown role: ${input.role}` })

  const password = passwordIssue(input.password)
  if (password) issues.push({ field: 'password', message: password })

  return issues
}

/**
 * O que está errado em mudar o papel ou o estado de uma conta.
 *
 * ⛔ O ÚLTIMO ADMIN ATIVO NÃO SAI: rebaixado ou desativado, ninguém mais entraria nas telas de
 * operação, e a única volta seria mexer no banco à mão. ⛔ Ninguém desativa a PRÓPRIA conta pela tela
 * — é o clique que tranca a pessoa do lado de fora no meio do que estava fazendo.
 */
export function userChangeIssues(target: IUser, change: { role?: TUserRole; disabled?: boolean }, actorId: string, users: readonly IUser[]): IUserIssue[] {
  const issues: IUserIssue[] = []
  const activeAdmins = users.filter((user) => user.role === 'admin' && !user.disabled)
  const removesAdmin = target.role === 'admin' && !target.disabled && (change.role === 'member' || change.disabled === true)

  if (change.role !== undefined && !USER_ROLES.includes(change.role)) issues.push({ field: 'role', message: `unknown role: ${String(change.role)}` })
  if (change.disabled === true && target.id === actorId) issues.push({ field: 'disabled', message: 'you cannot disable your own account' })
  if (removesAdmin && activeAdmins.length <= 1) issues.push({ field: change.role === 'member' ? 'role' : 'disabled', message: 'the last active administrator cannot be removed' })

  return issues
}
