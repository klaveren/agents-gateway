import { capMessage, capReached, hasCaps, ICapHit, IUsageCaps, IUsageSpent, monthStart, usageCaps } from '@domain/Usage.Cap'
import { costOf, TModelPricing } from '@domain/models/Model.Pricing'
import { IUsageQuery, IUsageRow } from '@domain/models/Usage.Model'

/** Quanto o cache das linhas do mês vale: o teto é conferido a cada turno, e somar o mês a cada um pesaria. */
const CACHE_MS = 15_000

export interface IUsageCapStatus {
  caps: IUsageCaps
  /** Do dia 1º (UTC) até agora. */
  since: string
  gateway: IUsageSpent
  user?: IUsageSpent
  reached?: ICapHit
}

/**
 * ⚖️ O TETO DE USO: soma o mês (as mesmas linhas da tela Uso, precificadas pelo catálogo) e diz se um teto bateu.
 * Sem teto configurado, não lê nada. ⚠️ O custo de modelo sem preço não entra (o mesmo piso da tela Uso).
 */
export class UsageCapService {
  private cached?: { at: number; since: number; rows: IUsageRow[] }

  constructor(
    private readonly usage: (query: IUsageQuery) => Promise<IUsageRow[]>,
    private readonly pricingOf: (provider: string) => TModelPricing,
    private readonly now: () => Date = () => new Date(),
    private readonly caps: () => IUsageCaps = () => usageCaps(),
  ) {}

  /** O motivo da recusa, ou nada: o turno pode começar. */
  async refusal(ownerId?: string): Promise<string | undefined> {
    const caps = this.caps()
    if (!hasCaps(caps)) return undefined
    const status = await this.status(ownerId, caps)
    return status.reached ? capMessage(status.reached) : undefined
  }

  async status(ownerId?: string, caps: IUsageCaps = this.caps()): Promise<IUsageCapStatus> {
    const since = monthStart(this.now())
    const rows = await this.rows(since)
    const gateway = this.spent(rows)
    const user = ownerId ? this.spent(rows.filter((row) => row.ownerId === ownerId)) : undefined
    const reached = capReached(caps, gateway, user)
    return { caps, since: since.toISOString(), gateway, ...(user ? { user } : {}), ...(reached ? { reached } : {}) }
  }

  private async rows(since: Date): Promise<IUsageRow[]> {
    const at = this.now().getTime()
    if (this.cached && this.cached.since === since.getTime() && at - this.cached.at < CACHE_MS) return this.cached.rows
    const rows = await this.usage({ since, tzOffsetMinutes: 0 })
    this.cached = { at, since: since.getTime(), rows }
    return rows
  }

  private spent(rows: readonly IUsageRow[]): IUsageSpent {
    let costUsd = 0
    let tokens = 0
    let costIsFloor = false
    for (const row of rows) {
      const cost = costOf(row.model, row.usage, this.pricingOf(row.provider))
      if (cost === undefined) costIsFloor = true
      costUsd += cost ?? 0
      tokens += (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0)
    }
    return { costUsd, tokens, ...(costIsFloor ? { costIsFloor } : {}) }
  }
}
