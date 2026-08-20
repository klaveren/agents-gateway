import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { ISessionRecord } from '@infra/session/Session.Store'

export interface IAgentProvider {
  createSession(input: ICreateSessionInput): Promise<IAgentSession>
  sendMessage(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
  dispose(sessionId: string): Promise<void>
  describe(sessionId: string): ISessionRecord
  list(): ISessionRecord[]
}
