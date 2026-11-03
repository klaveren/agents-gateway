import type { ILedgerContext, ILedgerLine, ILedgerRevision } from '@domain/models/Ledger.Model'

export type TNewLedgerContext = Omit<ILedgerContext, 'id'>
export type TNewLedgerLine = Omit<ILedgerLine, 'id'>
export type TLedgerContextChange = Partial<Pick<ILedgerContext, 'trigger' | 'playbook'>> & Pick<ILedgerContext, 'updatedAt' | 'updatedBy'>
export type TLedgerLineChange = Partial<Pick<ILedgerLine, 'date' | 'type' | 'trigger' | 'learning' | 'ref'>> & Pick<ILedgerLine, 'updatedAt' | 'updatedBy'>

/** O ledger dos agentes (ver `Ledger.Model`): contextos, linhas e as revisões de cada mudança. */
export interface ILedgerRepository {
  /** Os contextos do agente, por tema. */
  contexts(agentId: string): ILedgerContext[]
  context(agentId: string, topic: string): ILedgerContext | undefined
  /** As linhas de um contexto, na ordem em que entraram. */
  lines(contextId: number): ILedgerLine[]
  /** Todas as linhas do agente, com o tema de cada uma. */
  agentLines(agentId: string): Array<ILedgerLine & { topic: string }>
  createContext(context: TNewLedgerContext): ILedgerContext
  updateContext(id: number, change: TLedgerContextChange): void
  /** Sai com as linhas. As revisões ficam (são o histórico). */
  deleteContext(id: number): void
  addLine(line: TNewLedgerLine): ILedgerLine
  updateLine(id: number, change: TLedgerLineChange): void
  deleteLine(id: number): void
  addRevision(revision: Omit<ILedgerRevision, 'id'>): void
  /** Da mais nova para a mais velha. */
  revisions(agentId: string, topic: string, limit?: number): ILedgerRevision[]
  /** Tudo ou nada: a mudança e a revisão dela. */
  transaction<T>(work: () => T): T
}
