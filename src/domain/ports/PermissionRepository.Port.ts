import { IPermissionRule, IPermissionSubject, IPermissionVerdict } from '@domain/Permission.Policy'

/** Uma decisão registrada: o que foi pedido, por quem, e o que decidiu. Para a tela (Últimas decisões) e auditoria. */
export interface IPermissionDecision {
  at: Date
  projectId?: string
  agentId?: string
  sessionId?: string
  category: IPermissionSubject['category']
  subject: string
  allowed: boolean
  layer: IPermissionVerdict['layer']
  pattern?: string
}

export interface IPermissionRepository {
  /** As regras do projeto (vazio = nenhuma: tudo negado). */
  projectRules(projectId: string): { rules: IPermissionRule[]; updatedAt?: Date; updatedBy?: string }
  saveProjectRules(projectId: string, rules: IPermissionRule[], by: string): void
  /** ⚖️ Guarda só as últimas `PERMISSION_DECISIONS_KEPT` por projeto: é para a tela, não um log infinito. */
  logDecision(decision: IPermissionDecision): void
  decisions(projectId: string, options?: { agentId?: string; limit?: number }): IPermissionDecision[]
  deleteProject(projectId: string): void
}

export const PERMISSION_DECISIONS_KEPT = 500
