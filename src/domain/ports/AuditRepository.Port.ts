import { IAuditEvent, IAuditQuery, TNewAuditEvent } from '@domain/models/Audit.Model'

/** Onde os eventos de auditoria ficam (ver `Audit.Model`). Gravar nunca derruba quem grava. */
export interface IAuditRepository {
  append(event: TNewAuditEvent): void
  /** Do mais novo para o mais antigo. */
  query(filter: IAuditQuery): IAuditEvent[]
  /** Quantos eventos o recorte tem, sem a página (`before`, `offset` e `limit` não contam). */
  count?(filter: IAuditQuery): number
}
