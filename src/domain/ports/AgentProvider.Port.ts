import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'

export interface IAgentProvider {
  createSession(input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(agentId: string, sessionId: string): Promise<void>
}
