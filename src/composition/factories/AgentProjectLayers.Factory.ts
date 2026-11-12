import { AgentProjectLayerService } from '@application/AgentProjectLayer.Service'
import { SqliteAgentProjectLayerRepository } from '@infra/persistence/Sqlite.AgentProjectLayerRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { AgentProjectLayerController } from '@infra/http/AgentProjectLayer.Controller'
import { makeAgents } from './Agents.Factory'
import { makeAuth } from './Auth.Factory'
import { makeProjects } from './Projects.Factory'

let instance: AgentProjectLayerService | undefined

/**
 * As camadas de projeto dos agentes globais: UMA instância — o catálogo (que as aplica no `getIn`), as permissões e as
 * rotas veem as mesmas. No MESMO arquivo das conversas; `off` deixa só em memória.
 */
export function makeAgentProjectLayers(): AgentProjectLayerService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  instance = new AgentProjectLayerService({
    repository: new SqliteAgentProjectLayerRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH),
    // ⚠️ Pedido na hora: o catálogo dos agentes usa esta fábrica ao nascer.
    agents: { entry: (id) => makeAgents().entry(id) },
    projectExists: (projectId) => makeProjects().exists(projectId),
  })
  return instance
}

export function makeAgentProjectLayerController(): AgentProjectLayerController {
  return new AgentProjectLayerController({ layers: makeAgentProjectLayers(), proof: makeAuth().proof })
}
