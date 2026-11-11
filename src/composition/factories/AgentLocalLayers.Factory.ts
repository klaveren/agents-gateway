import { AgentLocalLayerService } from '@application/AgentLocalLayer.Service'
import { SqliteAgentLocalLayerRepository } from '@infra/persistence/Sqlite.AgentLocalLayerRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { makeAgents } from './Agents.Factory'
import { isConnectedProject } from './Projects.Factory'

let instance: AgentLocalLayerService | undefined

/**
 * 🔌 As camadas locais dos agentes de projeto conectado: UMA instância — o catálogo dos agentes (que as aplica) e as
 * rotas (que as gravam) veem as mesmas. No MESMO arquivo das conversas; `off` deixa só em memória.
 */
export function makeAgentLocalLayers(): AgentLocalLayerService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new AgentLocalLayerService({
    repository: new SqliteAgentLocalLayerRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    // ⚠️ Pedido na hora: o catálogo dos agentes usa esta fábrica ao nascer.
    agents: {
      entry: (id) => makeAgents().entry(id),
      rawEntries: () => makeAgents().rawEntries(),
      applyLocalLayer: (id, layer, by) => makeAgents().applyLocalLayer(id, layer, by),
    },
    connected: isConnectedProject,
  })
  return instance
}
