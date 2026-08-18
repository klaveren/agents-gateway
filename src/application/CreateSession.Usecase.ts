import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentSession } from '@domain/models/AgentSession'
import { IAgentProvider } from '@domain/ports/AgentProvider'

export class CreateSessionUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async execute(input: ICreateSessionInput): Promise<IAgentSession> {
    return this.agentProvider.createSession(input)
  }
}
