import { ISession } from '@domain/models/Session.Model'
import { IAgentProvider, ISessionChange } from '@domain/ports/AgentProvider.Port'

export class ReconfigureSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  execute(sessionId: string, change: ISessionChange): ISession {
    return this.agentProvider.reconfigure(sessionId, change)
  }
}
