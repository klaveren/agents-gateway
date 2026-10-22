import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_REGISTRY } from '@domain/Agent.Registry'
import { IAgentRepository } from '@domain/ports/AgentRepository.Port'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { makeModelCatalog } from './Catalog.Factory'

let instance: AgentCatalog | undefined

/**
 * Os agentes do gateway — todos no banco. Os três de sempre entram como SEMENTE no primeiro boot
 * (`seedOnce`) e viram agentes comuns; os modelos que valem são os ativados no catálogo.
 *
 * ⚠️ UMA INSTÂNCIA SÓ, pelo mesmo motivo de `makeSettings`: o provider (que abre a sessão) e o
 * controller (que cria o agente) precisam ver a MESMA lista — com duas, o agente recém-criado
 * apareceria na tela e daria `agent_not_found` ao abrir conversa.
 *
 * ⚖️ O MESMO ARQUIVO das conversas e das configurações (`CONVERSATIONS_DB`); `off` deixa os criados
 * só em memória.
 */
export function makeAgents(): AgentCatalog {
  if (instance) return instance

  const repository = build()
  repository.seedOnce(AGENT_REGISTRY, 'seed')

  // ⚠️ O catálogo é pedido NA HORA, não aqui: ele próprio lê os agentes ao nascer (para ativar os
  // modelos que eles já usam), e pedi-lo agora seria uma volta sem fim entre as duas fábricas.
  instance = new AgentCatalog([], repository, (provider, model) => makeModelCatalog().isEnabled(provider, model))
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
