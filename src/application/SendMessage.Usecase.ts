import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IMessageInput } from '@domain/models/MessageInput.Model'

export class SendMessageUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async *execute(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    yield* this.agentProvider.sendMessage(agentId, sessionId, input)
  }
}
