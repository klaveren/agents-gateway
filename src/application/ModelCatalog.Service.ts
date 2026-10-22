import { InvalidModelError, ModelNotFoundError } from '@domain/errors/Domain.Error'
import { ICatalogModel, IListedModel, IModelReasoning } from '@domain/models/ModelCatalog.Model'
import { IModelPrice, TModelPricing } from '@domain/models/Model.Pricing'
import { IModelCatalogRepository } from '@domain/ports/ModelCatalogRepository.Port'

export interface ISyncResult {
  added: number
  updated: number
  /** Estavam no catálogo e sumiram da listagem: marcados indisponíveis, não apagados. */
  missing: number
  total: number
}

/**
 * O catálogo de modelos: o que cada provider oferece, o que está ATIVADO para uso, e quanto custa.
 *
 * ⚖️ A LISTAGEM PROPÕE, QUEM ADMINISTRA DECIDE: sincronizar traz modelos novos desligados e nunca liga
 * nem desliga nada por conta própria; nunca apaga (modelo que sumiu fica marcado, e as conversas
 * antigas com ele continuam com preço); e nunca troca preço `manual`.
 */
export class ModelCatalogService {
  constructor(
    private readonly catalog: IModelCatalogRepository,
    /** A tabela de fábrica (+ arquivo), sugerida só nos oficiais: um compatível pode cobrar outro preço pelo mesmo id. */
    private readonly defaults: TModelPricing,
    private readonly isOfficial: (providerId: string) => boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(providerId: string): ICatalogModel[] {
    return this.catalog.list(providerId)
  }

  enabledIds(providerId: string): string[] {
    return this.catalog
      .list(providerId)
      .filter((model) => model.enabled)
      .map((model) => model.modelId)
  }

  /** O que o catálogo sabe do raciocínio do modelo; `undefined` = não sabe. */
  reasoningOf(providerId: string, modelId: string): IModelReasoning | undefined {
    return this.catalog.get(providerId, modelId)?.reasoning
  }

  isEnabled(providerId: string, modelId: string): boolean {
    return this.catalog.get(providerId, modelId)?.enabled === true
  }

  sync(providerId: string, listed: readonly IListedModel[], by: string): ISyncResult {
    const now = this.now()
    const seen = new Set<string>()
    let added = 0
    let updated = 0

    for (const item of listed) {
      if (!item.id || seen.has(item.id)) continue
      seen.add(item.id)

      const current = this.catalog.get(providerId, item.id)
      const suggested = this.suggestedPrice(providerId, item)

      if (!current) {
        this.catalog.insert({
          providerId,
          modelId: item.id,
          label: item.label,
          enabled: false,
          available: true,
          contextLength: item.contextLength,
          ...suggested,
          reasoning: item.reasoning,
          syncedAt: now,
          updatedAt: now,
          updatedBy: by,
        })
        added += 1
        continue
      }

      // Preço manual fica; o resto acompanha o que o provider diz hoje.
      const price = current.priceSource === 'manual' ? {} : suggested
      this.catalog.update(providerId, item.id, {
        label: item.label ?? current.label,
        available: true,
        contextLength: item.contextLength ?? current.contextLength,
        reasoning: item.reasoning ?? current.reasoning,
        ...price,
        syncedAt: now,
      })
      updated += 1
    }

    let missing = 0
    for (const model of this.catalog.list(providerId)) {
      if (seen.has(model.modelId) || !model.available) continue
      this.catalog.update(providerId, model.modelId, { available: false, syncedAt: now })
      missing += 1
    }

    return { added, updated, missing, total: seen.size }
  }

  /**
   * Garante que um modelo JÁ EM USO (por um agente) está no catálogo e ativado — é o que deixa a troca
   * de "modelos no código" para "modelos ativados" sem quebrar nenhum agente que existia.
   */
  ensureEnabled(providerId: string, modelId: string, by: string): void {
    if (this.catalog.get(providerId, modelId)) return
    const now = this.now()
    this.catalog.insert({ providerId, modelId, enabled: true, available: true, ...this.suggestedPrice(providerId, { id: modelId }), updatedAt: now, updatedBy: by })
  }

  setEnabled(providerId: string, modelId: string, enabled: boolean, by: string): ICatalogModel {
    this.require(providerId, modelId)
    return this.catalog.update(providerId, modelId, { enabled, updatedAt: this.now(), updatedBy: by }) as ICatalogModel
  }

  /** Preço digitado vira `manual`; `null` apaga o manual e volta ao do catálogo ou de fábrica. */
  setPrice(providerId: string, modelId: string, price: IModelPrice | null, by: string): ICatalogModel {
    this.require(providerId, modelId)
    const now = this.now()

    if (price === null) {
      const fallback = this.defaultPrice(providerId, modelId)
      return this.catalog.update(providerId, modelId, { price: fallback, priceSource: fallback ? 'default' : undefined, updatedAt: now, updatedBy: by }) as ICatalogModel
    }

    for (const [field, value] of Object.entries(price)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 10_000))
        throw new InvalidModelError([{ field, message: 'price per 1M tokens must be between 0 and 10000' }])
    }
    return this.catalog.update(providerId, modelId, { price, priceSource: 'manual', updatedAt: now, updatedBy: by }) as ICatalogModel
  }

  /** Os preços de um provider, no formato que `costOf` lê. */
  pricing(providerId: string): TModelPricing {
    const prices: TModelPricing = this.isOfficial(providerId) ? { ...this.defaults } : {}
    for (const model of this.catalog.list(providerId)) if (model.price) prices[model.modelId] = model.price
    return prices
  }

  clear(providerId: string): void {
    this.catalog.clear(providerId)
  }

  private suggestedPrice(providerId: string, item: IListedModel): Pick<ICatalogModel, 'price' | 'priceSource'> {
    if (item.price) return { price: item.price, priceSource: 'catalog' }
    const fallback = this.defaultPrice(providerId, item.id)
    return fallback ? { price: fallback, priceSource: 'default' } : { price: undefined, priceSource: undefined }
  }

  private defaultPrice(providerId: string, modelId: string): IModelPrice | undefined {
    return this.isOfficial(providerId) && Object.hasOwn(this.defaults, modelId) ? this.defaults[modelId] : undefined
  }

  private require(providerId: string, modelId: string): ICatalogModel {
    const model = this.catalog.get(providerId, modelId)
    if (!model) throw new ModelNotFoundError(providerId, modelId)
    return model
  }
}
