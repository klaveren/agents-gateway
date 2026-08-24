import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISession } from '@domain/models/Session.Model'

export class GetSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(sessionId: string): Promise<ISession> {
    return this.agentProvider.describe(sessionId)
  }
}
