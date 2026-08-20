import { getAgentById } from '@domain/Agent.Registry'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { readMode } from '@infra/session/Session.Key'

/** Chave do mapa de adapters: cada provider tem uma implementação por lane. */
export function adapterKey(provider: EProvider, mode: EMode): string {
  return `${provider}:${mode}`
}

export class AgentProvider implements IAgentProvider {
  constructor(private adapters: Map<string, IAgentAdapter>) {}

  private getAdapter(provider: EProvider, mode: EMode): IAgentAdapter {
    const adapter = this.adapters.get(adapterKey(provider, mode))
    if (!adapter) {
      throw new Error(`Adapter not found for provider: ${provider} (mode: ${mode})`)
    }
    return adapter
  }

  private getAgent(agentId: string): IAgent {
    const agent = getAgentById(agentId)
    if (!agent) throw new Error(`Agent not found: ${agentId}`)
    return agent
  }

  async createSession(input: ICreateSessionInput): Promise<IAgentSession> {
    const agent = this.getAgent(input.agentId)
    const mode = input.mode ?? EMode.CHAT

    if (!agent.modes.includes(mode)) {
      throw new Error(`Agent ${agent.id} does not support mode: ${mode}`)
    }

    return this.getAdapter(agent.provider, mode).createSession(agent, { ...input, mode })
  }

  async *sendMessage(agentId: string, sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const agent = this.getAgent(agentId)
    const mode = readMode(sessionId) ?? EMode.CHAT
    yield* this.getAdapter(agent.provider, mode).sendMessage(agent, sessionId, input)
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const agent = this.getAgent(agentId)
    const mode = readMode(sessionId) ?? EMode.CHAT
    return this.getAdapter(agent.provider, mode).cancel(sessionId)
  }
}
