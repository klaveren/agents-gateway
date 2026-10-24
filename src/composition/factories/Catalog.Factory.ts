import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { SqliteModelCatalogRepository } from '@infra/persistence/Sqlite.ModelCatalogRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { loadPricing } from '@infra/pricing/Pricing.File'
import { makeProviders } from './Providers.Factory'

let instance: ModelCatalogService | undefined

/**
 * O catálogo de modelos. ⚠️ UMA INSTÂNCIA SÓ, como os outros de configuração.
 *
 * ⛔ O BOOT NÃO LIGA MODELO NENHUM: ativar é decisão de quem administra. Antes, todo modelo declarado por
 * algum agente (inclusive os da semente) entrava ligado a cada boot — e "ativado" deixava de dizer nada.
 */
export function makeModelCatalog(): ModelCatalogService {
  if (instance) return instance

  const configured = process.env.CONVERSATIONS_DB?.trim()
  const repository = new SqliteModelCatalogRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  const providers = makeProviders()

  const catalog = new ModelCatalogService(repository, loadPricing(), (id) => providers.get(id)?.official ?? false)
  instance = catalog
  return catalog
}
