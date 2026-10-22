import { ModelCatalogService } from '@application/ModelCatalog.Service'
import { SqliteModelCatalogRepository } from '@infra/persistence/Sqlite.ModelCatalogRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { loadPricing } from '@infra/pricing/Pricing.File'
import { makeAgents } from './Agents.Factory'
import { makeProviders } from './Providers.Factory'

let instance: ModelCatalogService | undefined

/**
 * O catálogo de modelos. ⚠️ UMA INSTÂNCIA SÓ, como os outros de configuração.
 *
 * ⚖️ NO BOOT, OS MODELOS QUE OS AGENTES JÁ USAM entram no catálogo ativados (se ainda não estão): é o que
 * faz a troca de "lista no código" para "modelos ativados" acontecer sem nenhum agente perder modelo.
 * Só acrescenta — nunca desliga o que alguém desligou.
 */
export function makeModelCatalog(): ModelCatalogService {
  if (instance) return instance

  const configured = process.env.CONVERSATIONS_DB?.trim()
  const repository = new SqliteModelCatalogRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  const providers = makeProviders()

  const catalog = new ModelCatalogService(repository, loadPricing(), (id) => providers.get(id)?.official ?? false)
  instance = catalog
  // `rawEntries()`: a lista normal já passa pelo filtro do catálogo, que é este que está nascendo.
  for (const { agent } of makeAgents().rawEntries()) for (const model of agent.models) catalog.ensureEnabled(agent.provider, model, 'seed')

  return catalog
}
