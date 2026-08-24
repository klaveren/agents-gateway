import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'

export interface IAgentAdapter {
  createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(agent: IAgent, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
}
