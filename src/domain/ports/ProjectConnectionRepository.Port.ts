import type { IProjectConnection } from '../models/ProjectConnection.Model'
import type { ILedgerWrite } from '../models/Ledger.Model'

export type TConnectionPatch = Partial<Omit<IProjectConnection, 'projectId' | 'createdAt' | 'createdBy'>> & { tokenSealed?: string }

/** Onde ficam as conexões dos projetos conectados (o token, selado). */
export interface IProjectConnectionRepository {
  insert(connection: IProjectConnection, tokenSealed: string): void
  get(projectId: string): IProjectConnection | undefined
  list(): IProjectConnection[]
  tokenSealed(projectId: string): string | undefined
  update(projectId: string, patch: TConnectionPatch): void
  remove(projectId: string): void
  /** 🔌 A fila das escritas no ledger feitas com a origem fora do ar, na ordem. */
  enqueueLedger(entry: Omit<ILedgerOutboxEntry, 'id'>): void
  pendingLedger(projectId: string): ILedgerOutboxEntry[]
  dropLedger(id: number): void
}

/** Uma escrita no ledger que espera a origem voltar. */
export interface ILedgerOutboxEntry {
  id: number
  projectId: string
  agentId: string
  change: ILedgerWrite
  conversationId?: string
  createdAt: Date
}
