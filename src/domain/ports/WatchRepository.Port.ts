import { IWatch } from '@domain/models/Watch.Model'

/** O que muda numa vigia depois de armada. `null` apaga o campo. */
export type TWatchPatch = Partial<Pick<IWatch, 'status' | 'checks' | 'failures' | 'endReason' | 'delivered' | 'deliveryAttempts'>> & {
  nextCheckAt?: Date | null
  lastOutput?: string | null
  endedAt?: Date | null
}

/** Onde as vigias ficam: sobrevivem ao reinício do gateway (ver `Watch.Runner`). */
export interface IWatchRepository {
  insert(watch: IWatch): void
  find(id: string): IWatch | undefined
  /** As da conversa, da mais nova para a mais antiga. */
  listBySession(sessionId: string, limit?: number): IWatch[]
  countActive(sessionId?: string): number
  /** As ativas com conferência (ou prazo) vencida e as encerradas com entrega pendente vencida, da mais atrasada para a menos. */
  listDue(now: Date): IWatch[]
  update(id: string, patch: TWatchPatch): void
  /** Apaga as encerradas e entregues há mais tempo que `before`. */
  purge(before: Date): void
}
