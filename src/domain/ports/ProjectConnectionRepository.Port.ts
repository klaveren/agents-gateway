import type { IProjectConnection } from '../models/ProjectConnection.Model'

export type TConnectionPatch = Partial<Omit<IProjectConnection, 'projectId' | 'createdAt' | 'createdBy'>> & { tokenSealed?: string }

/** Onde ficam as conexões dos projetos conectados (o token, selado). */
export interface IProjectConnectionRepository {
  insert(connection: IProjectConnection, tokenSealed: string): void
  get(projectId: string): IProjectConnection | undefined
  list(): IProjectConnection[]
  tokenSealed(projectId: string): string | undefined
  update(projectId: string, patch: TConnectionPatch): void
  remove(projectId: string): void
}
