import { IAgentProvider } from '@domain/ports/AgentProvider'
import { IAgentAdapter } from '@domain/ports/IAgentAdapter'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput'
import { IAgentSession } from '@domain/models/AgentSession'
import { IAgentEvent } from '@domain/models/AgentEvent'
import { IMessageInput } from '@domain/models/MessageInput'
import { EProvider } from '@domain/enums/EProvider'
import { getAgentById } from '@domain/AgentRegistry'

export class AgentProvider implements IAgentProvider {
  constructor(private adapters: Map<EProvider, IAgentAdapter>) {}

  private getAdapter(providerName: EProvider): IAgentAdapter {
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new Error(`Adapter not found for provider: ${providerName}`)
    }
    return adapter
  }

  async createSession(input: ICreateSessionInput): Promise<IAgentSession> {
    const agent = getAgentById(input.agentId)
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`)

    const adapter = this.getAdapter(agent.provider)
    return adapter.createSession(agent, input)
  }

  async *sendMessage(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const agent = getAgentById(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)

    const adapter = this.getAdapter(agent.provider)
    yield* adapter.sendMessage(agent, sessionId, input)
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const agent = getAgentById(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)

    const adapter = this.getAdapter(agent.provider)
    return adapter.cancel(sessionId)
  }
}
