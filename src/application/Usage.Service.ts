import { IStoredUsage } from '@domain/models/Conversation.Model'
import { costOf, TModelPricing } from '@domain/models/Model.Pricing'
import { IUsageRow } from '@domain/models/Usage.Model'

/** Um bloco de uso: quanto, e — só quando há preço — quanto custou. */
export interface IUsageFigure {
  conversations: number
  turns: number
  usage: Required<IStoredUsage>
  /** Ausente sem tabela de preços (a visão de quem não administra). */
  costUsd?: number
  /** Algum modelo do bloco não tem preço: o custo é um PISO, não o valor exato. */
  costIsFloor?: boolean
}

export interface IUsageSummary {
  totals: IUsageFigure
  daily: Array<IUsageFigure & { date: string }>
  byAgent: Array<IUsageFigure & { agentId: string }>
  byModel: Array<IUsageFigure & { provider: string; model: string }>
  top: Array<IUsageFigure & { id: string; title?: string; agentId: string; provider: string; model: string }>
}

export interface IUserUsage extends IUsageFigure {
  /** Ausente = conversas sem dono (acesso anônimo). */
  ownerId?: string
  email?: string
}

const TOP = 10

/**
 * O uso montado a partir das linhas (um dia de uma conversa cada): totais, por dia, por agente, por
 * modelo, as conversas que mais consumiram e, para o admin, por usuário.
 *
 * ⚖️ CUSTO SÓ COM `pricingOf`: sem ele (a visão do usuário) nenhum campo de custo é calculado — e a
 * rota ainda o omite no DTO, as duas coisas. Com ele, cada linha é precificada pelo SEU provider e
 * modelo (a mesma `costOf` das conversas); linha sem preço não vira zero, marca o bloco como piso.
 */
export class UsageService {
  summarize(rows: readonly IUsageRow[], range: { days: string[] }, pricingOf?: (provider: string) => TModelPricing): IUsageSummary {
    const totals = new Figure()
    const daily = new Map<string, Figure>(range.days.map((day) => [day, new Figure()]))
    const byAgent = new Map<string, Figure>()
    const byModel = new Map<string, { provider: string; model: string; figure: Figure }>()
    const byConversation = new Map<string, { row: IUsageRow; figure: Figure }>()

    for (const row of rows) {
      const cost = pricingOf ? costOf(row.model, row.usage, pricingOf(row.provider)) : undefined
      const add = (figure: Figure) => figure.add(row, cost, !!pricingOf)

      add(totals)
      add(daily.get(row.day) ?? daily.set(row.day, new Figure()).get(row.day)!)
      add(byAgent.get(row.agentId) ?? byAgent.set(row.agentId, new Figure()).get(row.agentId)!)
      const modelKey = `${row.provider}\u0000${row.model}`
      add((byModel.get(modelKey) ?? byModel.set(modelKey, { provider: row.provider, model: row.model, figure: new Figure() }).get(modelKey)!).figure)
      add((byConversation.get(row.conversationId) ?? byConversation.set(row.conversationId, { row, figure: new Figure() }).get(row.conversationId)!).figure)
    }

    const heaviest = <T extends { figure: Figure }>(items: T[]) => items.sort((a, b) => b.figure.usage.totalTokens - a.figure.usage.totalTokens)

    return {
      totals: totals.view(),
      daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, figure]) => ({ date, ...figure.view() })),
      byAgent: heaviest([...byAgent.entries()].map(([agentId, figure]) => ({ agentId, figure }))).map(({ agentId, figure }) => ({ agentId, ...figure.view() })),
      byModel: heaviest([...byModel.values()]).map(({ provider, model, figure }) => ({ provider, model, ...figure.view() })),
      top: heaviest([...byConversation.values()])
        .slice(0, TOP)
        .map(({ row, figure }) => ({ id: row.conversationId, title: row.title, agentId: row.agentId, provider: row.provider, model: row.model, ...figure.view() })),
    }
  }

  /** Uma linha por dono, do que mais custou ao que menos (desempate pelos tokens). */
  byUser(rows: readonly IUsageRow[], pricingOf: (provider: string) => TModelPricing): IUserUsage[] {
    const users = new Map<string, { ownerId?: string; email?: string; figure: Figure }>()

    for (const row of rows) {
      const key = row.ownerId ?? '\u0000anonymous'
      const entry = users.get(key) ?? users.set(key, { ownerId: row.ownerId, email: row.ownerEmail, figure: new Figure() }).get(key)!
      entry.email ??= row.ownerEmail
      entry.figure.add(row, costOf(row.model, row.usage, pricingOf(row.provider)), true)
    }

    return [...users.values()]
      .map(({ ownerId, email, figure }) => ({ ownerId, email, ...figure.view() }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.usage.totalTokens - a.usage.totalTokens)
  }
}

/** Os dias do período, de `since` até hoje, no fuso de quem pergunta — inclusive os sem uso. */
export function usageDays(since: Date, now: Date, tzOffsetMinutes: number): string[] {
  const local = (date: Date) => new Date(date.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
  const days: string[] = []
  const last = local(now)
  for (let cursor = new Date(since); days.length < 400; cursor = new Date(cursor.getTime() + 86_400_000)) {
    const day = local(cursor)
    if (days.at(-1) !== day) days.push(day)
    if (day >= last) break
  }
  return days
}

class Figure {
  private readonly conversationIds = new Set<string>()
  turns = 0
  usage: Required<IStoredUsage> = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  private cost?: number
  private floor = false

  add(row: IUsageRow, cost: number | undefined, priced: boolean): void {
    this.conversationIds.add(row.conversationId)
    this.turns += row.turns
    for (const key of Object.keys(this.usage) as Array<keyof IStoredUsage>) this.usage[key] += row.usage[key] ?? 0

    if (!priced) return
    this.cost = (this.cost ?? 0) + (cost ?? 0)
    if (cost === undefined) this.floor = true
  }

  view(): IUsageFigure {
    const figure: IUsageFigure = { conversations: this.conversationIds.size, turns: this.turns, usage: { ...this.usage } }
    if (this.cost !== undefined) figure.costUsd = Math.round(this.cost * 1e6) / 1e6
    if (this.floor) figure.costIsFloor = true
    return figure
  }
}
