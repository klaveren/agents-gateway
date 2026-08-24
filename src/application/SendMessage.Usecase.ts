import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'

export class SendMessageUseCase {
  constructor(private agentProvider: IAgentProvider) {}

  async *execute(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    yield* this.agentProvider.sendMessage(sessionId, input)
  }
}
