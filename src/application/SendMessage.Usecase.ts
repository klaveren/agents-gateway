import { IAgentEvent } from '@domain/models/AgentEvent'
import { IAgentProvider } from '@domain/ports/AgentProvider'
import { IMessageInput } from '@domain/models/MessageInput'

export class SendMessageUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async *execute(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    yield* this.agentProvider.sendMessage(agentId, sessionId, input)
  }
}
