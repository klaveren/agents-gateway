import { IProjectAccount, IProjectAccountPublic, TProjectAccountKind } from '@domain/models/ProjectAccount.Model'

export interface IProjectAccountSave {
  kind: TProjectAccountKind
  label: string
  public: IProjectAccountPublic
  /** Ausente na edição = o segredo guardado fica. */
  secret?: string
}

export interface IProjectAccountRepository {
  list(projectId: string): IProjectAccount[]
  get(projectId: string, id: string): IProjectAccount | undefined
  /** ⛔ O segredo aberto: só para quem entrega ao comando (ou testa). Nunca para a tela. */
  secret(projectId: string, id: string): string | undefined
  save(projectId: string, id: string, input: IProjectAccountSave, by: string): IProjectAccount
  remove(projectId: string, id: string): boolean
  deleteProject(projectId: string): void
}
