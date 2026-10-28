import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_SEED } from '@domain/Agent.Seed'
import { builderAgent, PROTOCOLS } from '@domain/Builder.Agents'
import { IAgentSettings } from '@domain/models/Settings.Model'
import { IAgent } from '@domain/models/Agent.Model'
import { TProtocolKind } from '@domain/models/Protocol.Model'
import { targetFor } from '@domain/Agent.Policy'
import { IAgentRepository } from '@domain/ports/AgentRepository.Port'
import { NullAgentRepository } from '@infra/persistence/Null.AgentRepository'
import { SqliteAgentRepository } from '@infra/persistence/Sqlite.AgentRepository'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { targetUnavailable } from '@domain/Agent.Availability'
import { makeModelCatalog } from './Catalog.Factory'
import { makeProviders } from './Providers.Factory'
import { makeSettings } from './Settings.Factory'

let instance: AgentCatalog | undefined

/**
 * Os agentes do gateway — todos no banco. O Atlas entra como SEMENTE no primeiro boot (`seedOnce`) e
 * vira um agente comum; os modelos que valem são os ativados no catálogo.
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
  repository.seedOnce(AGENT_SEED, 'seed')

  // ⚠️ O catálogo é pedido NA HORA, não aqui: ele próprio lê os agentes ao nascer (para ativar os
  // modelos que eles já usam), e pedi-lo agora seria uma volta sem fim entre as duas fábricas.
  // "Pode rodar" (`targetUnavailable`), provider a provider, olhado como admin: é estrutural — provider, modelo, chave.
  // A restrição por papel (assinatura, ferramenta perigosa) é de quem chama, e o provider de sessões a aplica.
  const providers = makeProviders()
  const catalog: AgentCatalog = new AgentCatalog(
    repository,
    (provider, model) => makeModelCatalog().isEnabled(provider, model),
    (agent, target) => !targetUnavailable(agent, target, { provider: providers.get(target.provider), hasKey: !!providers.connection(target.provider)?.key, admin: true }),
    (): IAgent[] => coreAgents(catalog),
  )
  instance = catalog
  return catalog
}

/** A cópia viva das configurações, para o construtor nascer com o modelo escolhido (o `get` é síncrono). */
let settings: IAgentSettings | undefined
let watching = false

/**
 * O construtor de cada tipo, no modelo das configurações — senão no do Atlas (o primeiro alvo dele que roda agora).
 * Sem nenhum dos dois, não há construtor: a sessão responde "agente não encontrado".
 */
function coreAgents(catalog: AgentCatalog): IAgent[] {
  if (!watching) {
    watching = true
    const store = makeSettings()
    void store
      .read()
      .then((stored) => (settings = stored))
      .catch(() => undefined)
    store.subscribe((stored) => (settings = stored))
  }
  const atlas = catalog.list().find((agent) => agent.id === 'atlas')
  const fallback = atlas ? targetFor(atlas, undefined, undefined, (target) => catalog.isTargetRunnable(atlas, target)) : undefined
  const chosen = settings?.builderProvider && settings.builderModel ? { provider: settings.builderProvider, model: settings.builderModel } : fallback
  if (!chosen) return []
  return (Object.keys(PROTOCOLS) as TProtocolKind[]).map((kind) => builderAgent(kind, { provider: chosen.provider, models: [chosen.model] }))
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
