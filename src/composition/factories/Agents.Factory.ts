import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { IAgentRepository } from '@domain/ports/AgentRepository.Port'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'

let instance: AgentCatalog | undefined

/**
 * Os agentes do gateway: os embutidos mais os criados pela tela.
 *
 * ⚠️ UMA INSTÂNCIA SÓ, pelo mesmo motivo de `makeSettings`: o provider (que abre a sessão) e o
 * controller (que cria o agente) precisam ver a MESMA lista — com duas, o agente recém-criado
 * apareceria na tela e daria `agent_not_found` ao abrir conversa.
 *
 * ⚖️ O MESMO ARQUIVO das conversas e das configurações (`CONVERSATIONS_DB`); `off` deixa os criados
 * só em memória.
 */
export function makeAgents(): AgentCatalog {
  instance ??= new AgentCatalog(AGENT_REGISTRY, build())
  return instance
}

function build(): IAgentRepository {
  const configured = process.env.CONVERSATIONS_DB?.trim()
  if (configured === 'off') return new NullAgentRepository()

  try {
    return new SqliteAgentRepository(configured || DEFAULT_DB_PATH)
  } catch (error) {
    console.warn('[sqlite] não foi possível abrir o banco dos agentes; os criados ficam só em memória.', error)
    return new NullAgentRepository()
  }
}
