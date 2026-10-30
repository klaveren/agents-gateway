import { CatalogHistoryService } from '@application/CatalogHistory.Service'
import { CatalogReader } from '@application/Catalog.Reader'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteCatalogHistoryRepository } from '@infra/persistence/Sqlite.CatalogHistoryRepository'
import { agentRepository } from './Agents.Factory'
import { guidanceRepository } from './Guidance.Factory'
import { permissionRepository } from './Permissions.Factory'
import { projectRepository } from './Projects.Factory'
import { makeTools } from './Tools.Factory'

let instance: CatalogHistoryService | undefined

/**
 * O histórico do catálogo: UM serviço, no mesmo arquivo das conversas. O leitor usa os MESMOS repositórios dos serviços
 * de escrita — com `:memory:`, outra conexão seria outro banco.
 *
 * ⚠️ Pedido NA HORA (pelo gancho de cada serviço, ou no boot), nunca ao nascer de outra fábrica: ele depende de todas.
 */
export function makeCatalogHistory(): CatalogHistoryService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const reader = new CatalogReader({
    agents: agentRepository(),
    guidance: guidanceRepository(),
    permissions: permissionRepository(),
    mcps: makeTools().servers,
    projects: projectRepository(),
  })
  instance = new CatalogHistoryService(new SqliteCatalogHistoryRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH), reader)
  return instance
}

/**
 * A reconciliação do boot (ver `CatalogHistoryService.reconcile`): depois da semente, das migrações e da passagem para
 * projetos. ⛔ Nunca derruba o boot: sem ela, a próxima subida tenta de novo.
 */
export function reconcileCatalogHistory(): void {
  try {
    const { baseline, drift } = makeCatalogHistory().reconcile()
    if (baseline || drift) console.log(`[histórico] ${baseline} item(ns) sem revisão ganharam a baseline; ${drift} com deriva`)
  } catch (error) {
    console.warn('[histórico] a reconciliação do catálogo falhou:', error)
  }
}
