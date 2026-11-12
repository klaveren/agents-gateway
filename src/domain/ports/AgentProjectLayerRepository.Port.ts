import type { IAgentProjectLayer } from '../models/AgentLocalLayer.Model'

/** Onde ficam as camadas dos agentes GLOBAIS em cada projeto (uma por agente e projeto). */
export interface IAgentProjectLayerRepository {
  get(agentId: string, projectId: string): IAgentProjectLayer | undefined
  list(): IAgentProjectLayer[]
  save(layer: IAgentProjectLayer): void
  remove(agentId: string, projectId: string): void
  /** O agente saiu: as camadas dele em todo projeto vão junto. */
  removeAgent(agentId: string): void
  /** O projeto saiu: as camadas dos agentes nele vão junto. */
  removeProject(projectId: string): void
}
