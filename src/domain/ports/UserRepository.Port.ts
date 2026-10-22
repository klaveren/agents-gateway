import { IStoredUser } from '@domain/models/User.Model'

export type TUserPatch = Partial<Pick<IStoredUser, 'name' | 'role' | 'disabled' | 'passwordHash' | 'lastLoginAt' | 'updatedAt' | 'updatedBy' | 'sessionVersion'>>

/**
 * Onde ficam as contas.
 *
 * ⚖️ SÍNCRONO, como o de agentes: a prova do token (`LocalCallerProof`) relê a conta em TODA
 * requisição — é o que faz desativar ou rebaixar valer na hora —, e o driver já é síncrono.
 *
 * ⛔ ESCREVER LANÇA. Ler também: aqui a leitura decide quem entra, e "banco fora" virar "lista
 * vazia" faria o setup reabrir para qualquer um.
 */
export interface IUserRepository {
  count(): number
  list(): IStoredUser[]
  findById(id: string): IStoredUser | undefined
  findByEmail(email: string): IStoredUser | undefined
  insert(user: IStoredUser): void
  update(id: string, patch: TUserPatch): IStoredUser | undefined
}
