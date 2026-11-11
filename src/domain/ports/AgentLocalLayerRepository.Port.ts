import type { IAgentLocalLayer } from '../models/AgentLocalLayer.Model'

/** Onde ficam as camadas locais dos agentes de projeto conectado (uma por agente). */
export interface IAgentLocalLayerRepository {
  get(agentId: string): IAgentLocalLayer | undefined
  list(): IAgentLocalLayer[]
  save(layer: IAgentLocalLayer): void
  remove(agentId: string): void
}
