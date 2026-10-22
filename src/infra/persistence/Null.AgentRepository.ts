import { IAgent } from '@domain/models/Agent.Model'
import { IAgentRepository, IStoredAgent } from '@domain/ports/AgentRepository.Port'

/**
 * Agentes criados só em memória — `CONVERSATIONS_DB=off`, ou banco que não abriu. Somem no restart,
 * como as configurações nesse modo.
 */
export class NullAgentRepository implements IAgentRepository {
  private readonly agents = new Map<string, IStoredAgent>()

  list(): IStoredAgent[] {
    return [...this.agents.values()]
  }

  save(agent: IAgent, by: string): IStoredAgent {
    const now = new Date()
    const stored = { ...agent, createdAt: this.agents.get(agent.id)?.createdAt ?? now, updatedAt: now, updatedBy: by }
    this.agents.set(agent.id, stored)

    return stored
  }

  private seeded = false

  seedOnce(agents: readonly IAgent[], by: string): void {
    if (this.seeded) return
    this.seeded = true
    for (const agent of agents) if (!this.agents.has(agent.id)) this.save(agent, by)
  }

  delete(id: string): boolean {
    return this.agents.delete(id)
  }
}
