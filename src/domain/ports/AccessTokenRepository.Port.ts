import { IStoredAccessToken } from '@domain/models/AccessToken.Model'

/** Onde ficam os tokens de acesso. Síncrono, como as contas: é lido no caminho de cada requisição. */
export interface IAccessTokenRepository {
  insert(token: IStoredAccessToken): void
  listByUser(userId: string): IStoredAccessToken[]
  findByHash(tokenHash: string): IStoredAccessToken | undefined
  update(id: string, patch: Partial<Pick<IStoredAccessToken, 'lastUsedAt' | 'revokedAt'>>): void
}
