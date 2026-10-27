import { IProject, IProjectMember } from '@domain/models/Project.Model'

/** Onde ficam os projetos e quem é membro de cada um. Síncrono, como o resto do cadastro. */
export interface IProjectRepository {
  list(): IProject[]
  get(id: string): IProject | undefined
  insert(project: IProject): void
  update(id: string, patch: Partial<Pick<IProject, 'name' | 'description' | 'updatedAt' | 'updatedBy'>>): IProject | undefined
  delete(id: string): boolean
  members(projectId: string): IProjectMember[]
  /** Os projetos de que a conta é membro. */
  projectsOf(userId: string): string[]
  /** Troca a lista inteira de membros. */
  setMembers(projectId: string, userIds: readonly string[], by: string): void
  /** A marca de uma migração feita (para rodar uma vez só). */
  done(key: string): boolean
  markDone(key: string): void
}
