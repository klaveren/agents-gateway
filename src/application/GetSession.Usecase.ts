import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { ISessionRecord } from '@infra/session/Session.Store'

export class GetSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(sessionId: string): Promise<ISessionRecord> {
    return this.agentProvider.describe(sessionId)
  }
}
