import { ILoginSession } from '@domain/models/LoginSession.Model'
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
  /** Encerra UMA sessão (um navegador) até o token dela vencer. As outras da conta seguem. */
  revokeSession(sid: string, until: Date): void
  sessionRevoked(sid: string): boolean
  /** Grava (ou regrava, na renovação) a sessão de login que a lista "Sessões abertas" mostra. */
  saveSession(session: ILoginSession): void
  findSession(sid: string): ILoginSession | undefined
  /** As sessões da conta ainda no prazo, da usada mais recentemente para a mais antiga. */
  listSessions(userId: string, now: Date): ILoginSession[]
  /** Anota o último uso, no máximo uma vez a cada `minGapMs` (a escrita não acontece a cada requisição). */
  touchSession(sid: string, at: Date, minGapMs: number): void
  deleteSession(sid: string): void
}
