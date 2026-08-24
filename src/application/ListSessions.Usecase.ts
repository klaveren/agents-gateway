import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'

export class ListSessionsUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(): Promise<ISession[]> {
    return this.agentProvider.list()
  }
}
