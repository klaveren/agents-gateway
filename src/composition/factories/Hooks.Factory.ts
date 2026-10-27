import { AgentHooksService } from '@application/AgentHooks.Service'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteAgentHookRepository } from '@infra/persistence/Sqlite.AgentHookRepository'
import { makeAgents } from './Agents.Factory'
import { makeCredentials } from './Credentials.Factory'

let instance: AgentHooksService | undefined

/** Os hooks dos agentes: UM serviço, no mesmo arquivo das conversas (o controller e a remoção do agente o dividem). */
export function makeHooks(): AgentHooksService {
  if (instance) return instance
  const configured = process.env.CONVERSATIONS_DB?.trim()
  const repository = new SqliteAgentHookRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
  instance = new AgentHooksService(repository, makeCredentials(), (agentId) => !!makeAgents().get(agentId))
  return instance
}
