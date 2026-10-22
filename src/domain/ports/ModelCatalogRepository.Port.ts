import { ICatalogModel } from '@domain/models/ModelCatalog.Model'

export type TCatalogPatch = Partial<
  Pick<ICatalogModel, 'label' | 'enabled' | 'available' | 'contextLength' | 'price' | 'priceSource' | 'reasoning' | 'syncedAt' | 'updatedAt' | 'updatedBy'>
>

/** Onde fica o catálogo. Síncrono, como os outros de configuração: é lido no caminho de cada sessão. */
export interface IModelCatalogRepository {
  list(providerId?: string): ICatalogModel[]
  get(providerId: string, modelId: string): ICatalogModel | undefined
  insert(model: ICatalogModel): void
  update(providerId: string, modelId: string, patch: TCatalogPatch): ICatalogModel | undefined
  /** Apaga o catálogo de um provider (o provider foi removido). */
  clear(providerId: string): void
}
