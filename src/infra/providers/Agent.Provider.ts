import { getAgentById } from '@domain/Agent.Registry'
import { EMode } from '@domain/enums/EMode.Enum'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { AdapterNotFoundError, AgentNotFoundError, ModeNotSupportedError, SessionNotFoundError, ToolsNotSupportedError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IAgentEvent } from '@domain/models/AgentEvent.Model'
import { IAgentSession } from '@domain/models/AgentSession.Model'
import { ICreateSessionInput } from '@domain/models/CreateSessionInput.Model'
import { IMessageInput } from '@domain/models/MessageInput.Model'
import { IAgentProvider } from '@domain/ports/AgentProvider.Port'
import { IAgentAdapter } from '@domain/ports/AgentAdapter.Port'
import { ISessionRecord, SessionStore } from '@infra/session/Session.Store'

/** Chave do mapa de adapters: cada provider tem uma implementação por lane. */
export function adapterKey(provider: EProvider, mode: EMode): string {
  return `${provider}:${mode}`
}

export class AgentProvider implements IAgentProvider {
  constructor(
    private readonly adapters: Map<string, IAgentAdapter>,
    private readonly sessions: SessionStore,
  ) {}

  async createSession(input: ICreateSessionInput): Promise<IAgentSession> {
    const agent = this.getAgent(input.agentId)
    const mode = input.mode ?? EMode.CHAT

    if (!agent.modes.includes(mode)) {
      throw new ModeNotSupportedError(agent.id, mode)
    }

    // Na lane agent quem conduz o loop é o SDK; ligar o nosso por cima seria pedir duas
    // orquestrações para o mesmo turno.
    if (input.tools && mode !== EMode.CHAT) {
      throw new ToolsNotSupportedError(mode)
    }

    return this.getAdapter(agent.provider, mode).createSession(agent, { ...input, mode })
  }

  /**
   * O store sabe de que agente e de que lane é a sessão, então o chamador só precisa do id.
   * Antes o `agentId` viajava no path da requisição e nada garantia que ele batia com a
   * sessão — dava para pedir o agente errado e receber um "Session not found" sem sentido.
   */
  async *sendMessage(sessionId: string, input: IMessageInput): AsyncIterable<IAgentEvent> {
    const record = this.requireSession(sessionId)
    const agent = this.getAgent(record.agentId)
    const adapter = this.getAdapter(record.provider, record.mode)

    record.status = 'running'
    record.turns += 1

    try {
      for await (const event of adapter.sendMessage(agent, sessionId, input)) {
        // Somar o usage aqui vale para as seis implementações de uma vez.
        if (event.type === 'usage') this.sessions.addUsage(record, event.payload)
        yield event
      }
    } finally {
      record.status = 'idle'
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const record = this.requireSession(sessionId)
    return this.getAdapter(record.provider, record.mode).cancel(sessionId)
  }

  /** Encerrar inclui abortar o que estiver em curso: quem faz as duas coisas é o store. */
  async dispose(sessionId: string): Promise<void> {
    if (!this.sessions.delete(sessionId)) throw new SessionNotFoundError(sessionId)
  }

  describe(sessionId: string): ISessionRecord {
    return this.requireSession(sessionId)
  }

  list(): ISessionRecord[] {
    return this.sessions.list()
  }

  private requireSession(sessionId: string): ISessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) throw new SessionNotFoundError(sessionId)
    return record
  }

  private getAgent(agentId: string): IAgent {
    const agent = getAgentById(agentId)
    if (!agent) throw new AgentNotFoundError(agentId)
    return agent
  }

  private getAdapter(provider: EProvider, mode: EMode): IAgentAdapter {
    const adapter = this.adapters.get(adapterKey(provider, mode))
    if (!adapter) throw new AdapterNotFoundError(provider, mode)
    return adapter
  }
}
