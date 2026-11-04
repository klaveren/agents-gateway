import { LedgerService } from '@application/Ledger.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteLedgerRepository } from '@infra/persistence/Sqlite.LedgerRepository'
import { makeAgents } from './Agents.Factory'

let service: LedgerService | undefined

/** O ledger dos agentes: UM serviço, no mesmo arquivo das conversas (`off`: em memória). A tela, as ferramentas e o prompt o dividem. */
export function makeLedger(): LedgerService {
  if (service) return service
  const configured = process.env.CONVERSATIONS_DB?.trim()
  service = new LedgerService(new SqliteLedgerRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH), {
    // Pedido na hora: os agentes mudam (e a fábrica dos agentes lê o catálogo de ferramentas, que lê esta).
    get: (agentId) => {
      const agent = makeAgents().get(agentId)
      return agent ? { id: agent.id, ...(agent.projectId ? { projectId: agent.projectId } : {}), ...(agent.adminOnly ? { adminOnly: true } : {}) } : undefined
    },
  })
  return service
}
