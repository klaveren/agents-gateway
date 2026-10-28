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

  private readonly seeded = new Set<string>()
  private readonly migrated = new Set<string>()

  seedOnce(agents: readonly IAgent[], by: string): void {
    for (const agent of agents) {
      if (this.seeded.has(agent.id)) continue
      this.seeded.add(agent.id)
      if (!this.agents.has(agent.id)) this.save(agent, by)
    }
  }

  migrateOnce(key: string, agentId: string, change: (agent: IAgent) => IAgent | undefined, by: string): void {
    const mark = `${key}:${agentId}`
    if (this.migrated.has(mark)) return
    this.migrated.add(mark)
    const current = this.agents.get(agentId)
    const next = current ? change(current) : undefined
    if (next) this.save(next, by)
  }

  delete(id: string): boolean {
    return this.agents.delete(id)
  }
}
