import { AccountsService } from '@application/Accounts.Service'
import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { IUsageFigure, IUsageSummary, usageDays, UsageService } from '@application/Usage.Service'
import { MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { IUsageQuery, metadataKeyIssue } from '@domain/models/Usage.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { Request, Response } from 'express'
import { resolveCaller } from './Caller.Access'
import { checkAdminAccess } from './Caller.Admin'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { metadataFilter } from './Monitor.Query'

export interface IUsageControllerDeps {
  conversations: IConversationRepository
  proof?: ICallerProof
  /** Preços por provider (o catálogo). Ausente = a tabela de fábrica. */
  models?: ModelCatalogService
  /** Para pôr o NOME da conta local ao lado do e-mail, na visão do admin. */
  accounts?: AccountsService
  now?: () => Date
}

const PERIODS = [7, 30, 90]
/** O valor de `:value` que pede as conversas SEM a chave. */
const NO_VALUE = '~none'
const DAY = 86_400_000

/**
 * O uso: o de quem está logado (só tokens) e, para o admin, o de cada usuário (com custo).
 *
 * ⛔ CUSTO NUNCA SAI EM `/usage/me`: é o que a operação paga ao fornecedor, assunto de quem administra.
 * O serviço nem o calcula sem preço, e o DTO daqui ainda é uma lista explícita de campos — um campo de
 * custo novo não vaza por spread.
 */
export class UsageController {
  private readonly service = new UsageService()

  constructor(private readonly deps: IUsageControllerDeps) {
    for (const name of ['mine', 'users', 'user', 'byKey', 'byKeyValue'] as const) this[name] = this[name].bind(this)
  }

  /** O meu uso. Exige identidade: o anônimo não tem "meu". */
  async mine(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await resolveCaller(this.deps.proof)
      const identity = resolved?.identity
      if (!identity?.id) throw new HttpError(401, 'unauthorized', 'Sign in to see your usage')

      const { query, days, period } = this.range(req, { id: identity.id, account: identity.account })
      const rows = await this.deps.conversations.usage(query)
      return { period, ...withoutCost(this.service.summarize(rows, { days })) }
    })
  }

  /** Todos os usuários, com custo. Só admin. */
  async users(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('usageUsers')
      const { query, days, period } = this.range(req)
      const rows = await this.deps.conversations.usage(query)
      const names = new Map((this.deps.accounts?.list() ?? []).map((user) => [user.id, user.name]))
      const pricingOf = (provider: string) => this.pricingOf(provider)

      return {
        period,
        totals: this.service.summarize(rows, { days }, pricingOf).totals,
        users: this.service.byUser(rows, pricingOf).map((user) => ({ ...user, name: user.ownerId ? names.get(user.ownerId) : undefined })),
      }
    })
  }

  /**
   * O uso de UM usuário, com custo. Só admin. `:ownerId` = `anonymous` para as conversas sem dono.
   * ⚖️ Pelo id só, sem conta: o admin quer tudo o que essa pessoa gastou, em qualquer conta.
   */
  async user(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('usageUser')
      const ownerId = req.params.ownerId as string
      const { query, days, period } = this.range(req, ownerId === 'anonymous' ? null : { id: ownerId })
      const rows = (await this.deps.conversations.usage(query)).filter((row) => ownerId === 'anonymous' || row.ownerId === ownerId)
      const user = this.deps.accounts?.list().find((account) => account.id === ownerId)

      return {
        period,
        ownerId,
        name: user?.name,
        email: user?.email ?? rows.find((row) => row.ownerEmail)?.ownerEmail,
        ...this.service.summarize(rows, { days }, (provider) => this.pricingOf(provider)),
      }
    })
  }

  /**
   * O uso agrupado pelo valor de uma chave do `metadata` (`accountId`, `userId`…), com custo — a base de
   * cobrança de quem integra o gateway. Só admin. Os demais parâmetros da query que não são do período
   * filtram o recorte: `/usage/by/userId?accountId=xpto` são os usuários de uma conta.
   *
   * ⚠️ O `metadata` é DECLARADO por quem cria a sessão; o gateway não confere.
   */
  async byKey(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('usageByKey')
      const key = req.params.key as string
      const { query, days, period } = this.range(req)
      const rows = await this.deps.conversations.usage(this.grouped(query, key, req))
      const pricingOf = (provider: string) => this.pricingOf(provider)

      return { period, key, totals: this.service.summarize(rows, { days }, pricingOf).totals, groups: this.service.byGroup(rows, pricingOf) }
    })
  }

  /** O detalhe de UM valor da chave (dia, agente, modelo, conversas), com custo. `~none` = as conversas sem a chave. */
  async byKeyValue(req: Request, res: Response) {
    await this.respond(res, async () => {
      await this.requireAdmin('usageByKeyValue')
      const key = req.params.key as string
      const value = req.params.value as string
      const { query, days, period } = this.range(req)
      const rows = (await this.deps.conversations.usage(this.grouped(query, key, req))).filter((row) => (value === NO_VALUE ? row.group === undefined : row.group === value))

      return { period, key, ...(value === NO_VALUE ? {} : { value }), ...this.service.summarize(rows, { days }, (provider) => this.pricingOf(provider)) }
    })
  }

  /** O recorte com o agrupamento e os filtros de `metadata`. ⛔ Chave inválida é 422 aqui, antes de chegar ao SQL. */
  private grouped(query: IUsageQuery, key: string, req: Request): IUsageQuery {
    const filters = metadataFilter(req.query as Record<string, unknown>, ['days', 'tz']) ?? {}
    const issues = [key, ...Object.keys(filters)].flatMap((field) => {
      const message = metadataKeyIssue(field)
      return message ? [{ field, message }] : []
    })
    if (issues.length) throw new HttpError(422, 'validation_error', 'Invalid metadata key', issues)

    return { ...query, groupBy: key, ...(Object.keys(filters).length ? { metadata: filters } : {}) }
  }

  /** O período pedido (7, 30 ou 90 dias, contando hoje) e o fuso de quem pede. */
  private range(req: Request, owner?: IUsageQuery['owner']): { query: IUsageQuery; days: string[]; period: { days: number; since: string; tzOffsetMinutes: number } } {
    const requested = Number(req.query.days)
    const period = PERIODS.includes(requested) ? requested : 30
    const rawTz = Number(req.query.tz)
    const tz = Number.isFinite(rawTz) ? Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(rawTz))) : 0

    const now = (this.deps.now ?? (() => new Date()))()
    // Meia-noite LOCAL de (período - 1) dias atrás, em UTC.
    const localMidnight = Math.floor((now.getTime() + tz * 60_000) / DAY) * DAY - tz * 60_000
    const since = new Date(localMidnight - (period - 1) * DAY)

    const query: IUsageQuery = { since, tzOffsetMinutes: tz }
    if (owner !== undefined) query.owner = owner && owner.account === undefined ? { id: owner.id } : owner

    return { query, days: usageDays(since, now, tz), period: { days: period, since: since.toISOString(), tzOffsetMinutes: tz } }
  }

  private pricingOf(provider: string): TModelPricing {
    return this.deps.models?.pricing(provider) ?? MODEL_PRICING
  }

  private async requireAdmin(operation: string): Promise<void> {
    const access = await checkAdminAccess(this.deps.proof)
    if (!access.allowed) {
      console.warn(`[admin] acesso negado a ${operation}:`, access.reason)
      throw new HttpError(404, 'not_found', 'Not found')
    }
  }

  private async respond<T>(res: Response, work: () => Promise<T>) {
    try {
      res.status(200).json(ok(await work()))
    } catch (error: unknown) {
      const failure = toHttpFailure(error)
      if (failure.status >= 500) console.error('[UsageController] Error:', failure.message)
      res.status(failure.status).json(fail(failure.message, failure.code, failure.details))
    }
  }
}

/** ⛔ A visão de quem não administra: lista explícita, sem campo de custo nenhum. */
function figure(item: IUsageFigure) {
  return { conversations: item.conversations, turns: item.turns, usage: item.usage }
}

function withoutCost(summary: IUsageSummary) {
  return {
    totals: figure(summary.totals),
    daily: summary.daily.map((item) => ({ date: item.date, ...figure(item) })),
    byAgent: summary.byAgent.map((item) => ({ agentId: item.agentId, ...figure(item) })),
    byModel: summary.byModel.map((item) => ({ provider: item.provider, model: item.model, ...figure(item) })),
    top: summary.top.map((item) => ({ id: item.id, title: item.title, agentId: item.agentId, provider: item.provider, model: item.model, ...figure(item) })),
  }
}
