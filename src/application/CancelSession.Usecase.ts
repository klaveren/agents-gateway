import { IAgentProvider } from '@domain/ports/AgentProvider.Port'

export class CancelSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(sessionId: string): Promise<void> {
    return this.agentProvider.cancel(sessionId)
  }
}
