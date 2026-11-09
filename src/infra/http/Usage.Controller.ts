import { AccountsService } from '@application/Accounts.Service'
import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { UsageCapService } from '@application/UsageCap.Service'
import { IUsageFigure, IUsageSummary, usageDays, UsageService } from '@application/Usage.Service'
import { MODEL_PRICING, TModelPricing } from '@domain/models/Model.Pricing'
import { PROJECT_ID_PATTERN } from '@domain/models/Project.Model'
import { IUsageQuery, IUsageRow, metadataKeyIssue } from '@domain/models/Usage.Model'
import { sumToolUsage, type IToolUsage } from '@domain/models/ToolUsage.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { Request, Response } from 'express'
import { resolveCaller } from './Caller.Access'
import { ICallerProof } from './Caller.Proof'
import { HttpError, toHttpFailure } from './Http.Error'
import { fail, ok } from './Http.Response'
import { metadataFilter } from './Monitor.Query'
import { administers, adminView, IAdminView, requireAnyAdmin, requireProjectAdmin } from './Project.Access'

export interface IUsageControllerDeps {
  conversations: IConversationRepository
  proof?: ICallerProof
  /** Preços por provider (o catálogo). Ausente = a tabela de fábrica. */
  models?: ModelCatalogService
  /** Para pôr o NOME da conta local ao lado do e-mail, na visão do admin. */
  accounts?: AccountsService
  /** O teto de uso do mês (o mesmo que trava o turno). Ausente = a rota diz que não há teto. */
  cap?: UsageCapService
  now?: () => Date
}

const PERIODS = [7, 30, 90]
/** O período mais longo que se pede em dias (o mesmo teto da série diária). */
const MAX_DAYS = 400
/** O recorte de uma consulta de uso: a query, a série de dias e o período como a resposta o descreve. */
interface IUsageRange {
  query: IUsageQuery
  now: Date
  tz: number
  days: string[]
  period: { days: number | 'all'; since: string; tzOffsetMinutes: number }
}

/**
 * ⛔ O que o admin enxerga. `confined` = só os projetos que administra (e o sem-projeto, se for do gateway); `false` =
 * tudo (sem papéis registrados) ou um projeto que a rota já provou administrado (`?project=`).
 */
interface IUsageScope {
  confined: boolean
  view: IAdminView
}

/** O valor de `:value` que pede as conversas SEM a chave. */
const NO_VALUE = '~none'
/** As ferramentas que a tela mostra (as que mais pesaram). */
const TOOLS = 100
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
    for (const name of ['mine', 'users', 'user', 'byKey', 'byKeyValue', 'cap'] as const) this[name] = this[name].bind(this)
  }

  /** O meu uso. Exige identidade: o anônimo não tem "meu". */
  async mine(req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await resolveCaller(this.deps.proof)
      const identity = resolved?.identity
      if (!identity?.id) throw new HttpError(401, 'unauthorized', 'Sign in to see your usage')

      const { query, days, period } = this.range(req, { id: identity.id, account: identity.account })
      const rows = await this.deps.conversations.usage(query)
      const byTool = await this.toolsOf(query)
      // ⚖️ Quem administra o gateway já vê o custo de todos: o seu também aparece aqui, com ou sem teto. Os outros, sem custo.
      if ((await adminView(this.deps.proof))?.gateway)
        return { period, ...this.service.summarize(rows, { days }, (provider) => this.pricingOf(provider)), ...(byTool ? { byTool } : {}) }
      return { period, ...withoutCost(this.service.summarize(rows, { days })), ...(byTool ? { byTool } : {}) }
    })
  }

  /**
   * O teto de uso do mês contra o consumo: o meu e, para quem administra o gateway, o do gateway.
   * ⚖️ Quem não administra não vê custo (como no resto do Uso): do teto em US$, só a porcentagem.
   */
  async cap(_req: Request, res: Response) {
    await this.respond(res, async () => {
      const resolved = await resolveCaller(this.deps.proof)
      const identity = resolved?.identity
      if (!identity?.id) throw new HttpError(401, 'unauthorized', 'Sign in to see your usage')
      if (!this.deps.cap) return { caps: {} }
      const status = await this.deps.cap.status(identity.id)
      if ((await adminView(this.deps.proof))?.gateway) return status
      const { caps, since, user, reached } = status
      const percent = (used: number | undefined, cap: number | undefined) => (cap && used !== undefined ? Math.min(Math.round((used / cap) * 100), 100) : undefined)
      return {
        caps: { userMonthlyTokens: caps.userMonthlyTokens, monthlyTokens: caps.monthlyTokens },
        since,
        user: { tokens: user?.tokens ?? 0, costPercent: percent(user?.costUsd, caps.userMonthlyCostUsd), ...(user?.costIsFloor ? { costIsFloor: true } : {}) },
        ...(reached ? { reached: { scope: reached.scope, kind: reached.kind } } : {}),
      }
    })
  }

  /** Todos os usuários, com custo. Só admin. */
  async users(req: Request, res: Response) {
    await this.respond(res, async () => {
      const scope = await this.scopeOf(req, 'usageUsers')
      const { query, days, period } = this.range(req)
      const rows = await this.rows(query, scope)
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
      const scope = await this.scopeOf(req, 'usageUser')
      const ownerId = req.params.ownerId as string
      const { query, days, period } = this.range(req, ownerId === 'anonymous' ? null : { id: ownerId })
      const rows = (await this.rows(query, scope)).filter((row) => ownerId === 'anonymous' || row.ownerId === ownerId)
      const user = this.deps.accounts?.list().find((account) => account.id === ownerId)

      return {
        period,
        ownerId,
        name: user?.name,
        email: user?.email ?? rows.find((row) => row.ownerEmail)?.ownerEmail,
        ...this.service.summarize(rows, { days }, (provider) => this.pricingOf(provider)),
        ...(await this.toolsOf(query, scope).then((byTool) => (byTool ? { byTool } : {}))),
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
      const scope = await this.scopeOf(req, 'usageByKey')
      const key = req.params.key as string
      const range = this.range(req, undefined, { whole: true })
      const rows = await this.rows(this.grouped(range.query, key, req), scope)
      const { days, period } = this.spanned(range, rows)
      const pricingOf = (provider: string) => this.pricingOf(provider)

      return { period, key, totals: this.service.summarize(rows, { days }, pricingOf).totals, groups: this.service.byGroup(rows, pricingOf) }
    })
  }

  /** O detalhe de UM valor da chave (dia, agente, modelo, conversas), com custo. `~none` = as conversas sem a chave. */
  async byKeyValue(req: Request, res: Response) {
    await this.respond(res, async () => {
      const scope = await this.scopeOf(req, 'usageByKeyValue')
      const key = req.params.key as string
      const value = req.params.value as string
      const range = this.range(req, undefined, { whole: true })
      const rows = (await this.rows(this.grouped(range.query, key, req), scope)).filter((row) => (value === NO_VALUE ? row.group === undefined : row.group === value))
      const { days, period } = this.spanned(range, rows)

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

  /** O período pedido (contando hoje) e o fuso de quem pede. */
  private range(req: Request, owner?: IUsageQuery['owner'], options: { whole?: boolean } = {}): IUsageRange {
    const rawTz = Number(req.query.tz)
    const tz = Number.isFinite(rawTz) ? Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(rawTz))) : 0
    const now = (this.deps.now ?? (() => new Date()))()
    // ⚖️ Por chave, sem `days`, é o recorte INTEIRO: o custo de um épico é o do épico todo, por mais que ele dure.
    // Com `days`, qualquer inteiro de 1 a 400; fora disso é 422 (antes caía em 30 sem avisar).
    const whole = options.whole === true && req.query.days === undefined
    const period = whole ? undefined : this.periodOf(req.query.days, options.whole === true)

    // Meia-noite LOCAL de (período - 1) dias atrás, em UTC.
    const localMidnight = Math.floor((now.getTime() + tz * 60_000) / DAY) * DAY - tz * 60_000
    const since = new Date(period === undefined ? 0 : localMidnight - (period - 1) * DAY)

    const query: IUsageQuery = { since, tzOffsetMinutes: tz }
    if (owner !== undefined) query.owner = owner && owner.account === undefined ? { id: owner.id } : owner
    // `?project=<id>`: só as conversas desse projeto (o `metadata.project` que o gateway carimba ao abrir a conversa).
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : ''
    if (PROJECT_ID_PATTERN.test(project)) query.metadata = { project }

    return { query, now, tz, days: period === undefined ? [] : usageDays(since, now, tz), period: { days: period ?? 'all', since: since.toISOString(), tzOffsetMinutes: tz } }
  }

  /** `days` pedido. Na tela (sem chave) segue 7, 30 ou 90, com 30 de reserva; por chave, qualquer inteiro de 1 a 400. */
  private periodOf(raw: unknown, free: boolean): number {
    const requested = Number(raw)
    if (!free) return PERIODS.includes(requested) ? requested : 30
    if (!Number.isInteger(requested) || requested < 1 || requested > MAX_DAYS)
      throw new HttpError(422, 'validation_error', 'Invalid period', [{ field: 'days', message: `a whole number from 1 to ${MAX_DAYS}, or absent for the whole history` }])
    return requested
  }

  /** O recorte inteiro começa no primeiro dia com uso: a série diária vai dele até hoje. */
  private spanned(range: IUsageRange, rows: readonly { day: string }[]): Pick<IUsageRange, 'days' | 'period'> {
    if (range.period.days !== 'all') return range
    const first = rows.reduce<string | undefined>((min, row) => (min === undefined || row.day < min ? row.day : min), undefined)
    if (!first) return { days: [], period: { ...range.period, since: range.query.since.toISOString() } }
    const since = new Date(Date.parse(`${first}T00:00:00.000Z`) - range.tz * 60_000)
    return { days: usageDays(since, range.now, range.tz), period: { ...range.period, since: since.toISOString() } }
  }

  /** O peso de cada ferramenta no mesmo recorte (estimativa; ver `ToolUsage.Model`). Ausente sem o repositório que o conta. */
  private async toolsOf(query: IUsageQuery, scope?: IUsageScope): Promise<IToolUsage[] | undefined> {
    const toolUsage = this.deps.conversations.toolUsage?.bind(this.deps.conversations)
    if (!toolUsage) return undefined
    if (!scope?.confined) return (await toolUsage(query)).slice(0, TOOLS)
    // ⚠️ Confinado: projeto a projeto (a ferramenta não carrega o projeto). O que não tem projeto fica de fora desta soma.
    const projects = scope.view.projects === 'all' ? [] : [...scope.view.projects]
    const parts = await Promise.all(projects.map((project) => toolUsage({ ...query, metadata: { ...query.metadata, project } })))
    return sumToolUsage(parts).slice(0, TOOLS)
  }

  /**
   * ⛔ O recorte do admin. `?project=` de um projeto: só o admin dele (404 para os demais, o gateway inclusive); sem ele, o
   * que a visão administra (ver `IUsageScope`). Quem não administra nada: 404.
   */
  private async scopeOf(req: Request, operation: string): Promise<IUsageScope> {
    const view = await requireAnyAdmin(this.deps.proof, operation)
    const project = typeof req.query.project === 'string' ? req.query.project.trim() : ''
    if (PROJECT_ID_PATTERN.test(project)) {
      await requireProjectAdmin(this.deps.proof, project, operation)
      return { confined: false, view }
    }
    return { confined: view.projects !== 'all', view }
  }

  /**
   * As linhas do recorte, só do que o escopo admite. Confinado, uma consulta etiquetada pelo projeto da conversa
   * (`metadata.project`) diz de quem é cada uma; a que agrupa por outra chave filtra pelas conversas admitidas.
   */
  private async rows(query: IUsageQuery, scope: IUsageScope): Promise<IUsageRow[]> {
    if (!scope.confined) return this.deps.conversations.usage(query)
    const admitted = (await this.deps.conversations.usage({ ...query, groupBy: 'project' })).filter((row) => administers(scope.view, row.group))
    if (query.groupBy === undefined) return admitted.map(({ group: _group, ...row }) => row)
    const ids = new Set(admitted.map((row) => row.conversationId))
    return (await this.deps.conversations.usage(query)).filter((row) => ids.has(row.conversationId))
  }

  private pricingOf(provider: string): TModelPricing {
    return this.deps.models?.pricing(provider) ?? MODEL_PRICING
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
