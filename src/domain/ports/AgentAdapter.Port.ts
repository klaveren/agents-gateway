import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'

export interface IAgentAdapter {
  createSession(agent: IAgent, input: ICreateSessionInput): Promise<IAgentSession>
  /**
   * ⚖️ `context` vem do PROVIDER. O adapter não busca credencial em lugar nenhum — recebe a que
   * vale para esta chamada. É o que impede um adapter novo de esquecer de propagá-la, que foi
   * exatamente o que aconteceu quando cada um buscava por conta própria.
   */
  sendMessage(agent: IAgent, sessionId: string, input: IMessageInput, context: IExecutionContext): AsyncIterable<IAgentEvent>
  cancel(sessionId: string): Promise<void>
}
