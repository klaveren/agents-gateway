import { capMessage, capReached, hasCaps, ICapHit, IUsageCaps, IUsageSpent, monthStart, projectCapReached, usageCaps } from '@domain/Usage.Cap'
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
  /** 💰 O do projeto da conversa (com qualquer chave), quando ele tem teto. */
  project?: IUsageSpent & { id: string; caps: { monthlyCostUsd?: number; monthlyTokens?: number } }
  reached?: ICapHit
}

/** 💰 O teto por projeto (ver `IProjectModels.caps`) e de quem é cada provider (o de projeto não conta no do gateway). */
export interface IUsageCapScopes {
  projectCaps?: (projectId: string) => { monthlyCostUsd?: number; monthlyTokens?: number } | undefined
  providerProject?: (providerId: string) => string | undefined
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
    private readonly scopes: IUsageCapScopes = {},
  ) {}

  /** O motivo da recusa, ou nada: o turno pode começar. */
  async refusal(ownerId?: string, projectId?: string): Promise<string | undefined> {
    const caps = this.caps()
    const projectCaps = projectId ? this.scopes.projectCaps?.(projectId) : undefined
    if (!hasCaps(caps) && !projectCaps) return undefined
    const status = await this.status(ownerId, caps, projectId)
    return status.reached ? capMessage(status.reached) : undefined
  }

  /**
   * ⚖️ O teto do GATEWAY conta só o que o gateway paga: o gasto com a chave de um projeto (o provider do projeto) fica fora
   * dele — e entra no teto do projeto, que conta todas as conversas do projeto, com qualquer chave.
   */
  async status(ownerId?: string, caps: IUsageCaps = this.caps(), projectId?: string): Promise<IUsageCapStatus> {
    const since = monthStart(this.now())
    const rows = await this.rows(since)
    const paidByGateway = rows.filter((row) => !this.scopes.providerProject?.(row.provider))
    const gateway = this.spent(paidByGateway)
    const user = ownerId ? this.spent(paidByGateway.filter((row) => row.ownerId === ownerId)) : undefined
    const projectCaps = projectId ? this.scopes.projectCaps?.(projectId) : undefined
    const project = projectId && projectCaps ? { id: projectId, caps: projectCaps, ...this.spent(rows.filter((row) => row.group === projectId)) } : undefined
    const reached = capReached(caps, gateway, user) ?? (project ? projectCapReached(projectCaps, project) : undefined)
    return { caps, since: since.toISOString(), gateway, ...(user ? { user } : {}), ...(project ? { project } : {}), ...(reached ? { reached } : {}) }
  }

  private async rows(since: Date): Promise<IUsageRow[]> {
    const at = this.now().getTime()
    if (this.cached && this.cached.since === since.getTime() && at - this.cached.at < CACHE_MS) return this.cached.rows
    // O projeto de cada linha (`group`) para o teto do projeto.
    const rows = await this.usage({ since, tzOffsetMinutes: 0, groupBy: 'project' })
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
