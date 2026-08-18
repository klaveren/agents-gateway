import { IAgentSession } from '@domain/models/AgentSession'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { IAgent } from '@domain/models/Agent'
import { IMessageInput } from '@domain/models/MessageInput'

export interface IAgentAdapter {
  createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
}
