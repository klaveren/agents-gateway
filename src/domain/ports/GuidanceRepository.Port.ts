import { IProjectDoc, TDocKind } from '@domain/models/ProjectDoc.Model'
import { IRule } from '@domain/models/Rule.Model'

/** Um escopo: `null` = global; texto = o id do projeto. */
export type TGuidanceScope = string | null

/** `projectId: null` move para o global. */
export type TRulePatch = Partial<Pick<IRule, 'title' | 'body' | 'enabled' | 'position' | 'updatedAt' | 'updatedBy'>> & { projectId?: string | null }
export type TDocPatch = Partial<Pick<IProjectDoc, 'kind' | 'title' | 'summary' | 'body' | 'updatedAt' | 'updatedBy'>> & { projectId?: string | null }

/** As rules e os documentos (specs e ADRs). Síncrono, como o resto do cadastro. */
export interface IGuidanceRepository {
  /** As do escopo, pela posição. */
  rules(scope: TGuidanceScope): IRule[]
  rule(id: string): IRule | undefined
  insertRule(rule: IRule): void
  updateRule(id: string, patch: TRulePatch): IRule | undefined
  deleteRule(id: string): boolean

  /** Os do escopo, pelo tipo e pelo título. */
  docs(scope: TGuidanceScope, kind?: TDocKind): IProjectDoc[]
  doc(id: string): IProjectDoc | undefined
  insertDoc(doc: IProjectDoc): void
  updateDoc(id: string, patch: TDocPatch): IProjectDoc | undefined
  deleteDoc(id: string): boolean

  /** O projeto foi apagado: as rules e os documentos dele vão junto. */
  deleteProject(projectId: string): void
}
