import { IAgentSession } from '@domain/models/AgentSession'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { IMessageInput } from '@domain/models/MessageInput'

export interface IAgentProvider {
  createSession(input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(agentId: string, sessionId: string): Promise<void>
}
