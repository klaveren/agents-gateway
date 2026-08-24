import { IAgentProvider } from '@domain/ports/AgentProvider.Port'

export class DeleteSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(sessionId: string): Promise<void> {
    return this.agentProvider.dispose(sessionId)
  }
}
