import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'

export class CreateSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(input: ICreateSessionInput): Promise<IAgentSession> {
    return this.agentProvider.createSession(input)
  }
}
