import type { IPermissionRequest, TPermissionRequestKind } from '@domain/models/PermissionRequest.Model'

export interface IPermissionRequestFilter {
  agentId?: string
  projectId?: string
  kind?: TPermissionRequestKind
  /** `true`: só os gravados como pendentes (o vencido entra: vencer é calculado na leitura). */
  open?: boolean
  limit?: number
}

export interface IPermissionRequestDecision {
  status: 'approved' | 'rejected'
  by: string
  at: Date
  note?: string
}

/** Os pedidos de permissão dos agentes (ver `PermissionRequest.Model`). */
export interface IPermissionRequestRepository {
  create(request: IPermissionRequest): void
  get(id: string): IPermissionRequest | undefined
  /** Do mais novo para o mais velho. */
  list(filter?: IPermissionRequestFilter): IPermissionRequest[]
  /** ⛔ Só decide o que está pendente (gravado): `false` se já foi decidido. */
  decide(id: string, decision: IPermissionRequestDecision): boolean
}
