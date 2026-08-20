import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISessionRecord } from '@infra/session/Session.Store'

export class ListSessionsUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(): Promise<ISessionRecord[]> {
    return this.agentProvider.list()
  }
}
