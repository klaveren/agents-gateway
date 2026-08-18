import { IAgentProvider } from '@domain/ports/AgentProvider'

export class CancelSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(agentId: string, sessionId: string): Promise<void> {
    return this.agentProvider.cancel(agentId, sessionId)
  }
}
