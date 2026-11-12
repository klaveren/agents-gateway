import { AgentCatalog } from '@application/Agent.Catalog'
import { AGENT_SEED, ATLAS_AGENTS, atlasLitePrompt } from '@domain/Agent.Seed'
import { gatewayEdition, withoutLiteTools, withoutLiteTriggers } from '@domain/Edition.Policy'
import { applyAgentMigrations } from '@domain/Agent.Migrations'
import { builderAgent, importBuilderAgent, PROTOCOLS } from '@domain/Builder.Agents'
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
import { makeCatalogHistory } from './CatalogHistory.Factory'
import { makeAgentLocalLayers } from './AgentLocalLayers.Factory'
import { makeProjects } from './Projects.Factory'
import { makeProviders } from './Providers.Factory'
import { makeResourceSecrets } from './ResourceSecrets.Factory'
import { makeSettings } from './Settings.Factory'
import { makeResourceFiles } from './ResourceFiles.Factory'

let instance: AgentCatalog | undefined
let stored: IAgentRepository | undefined

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
  stored = repository
  // A semente (ver `AGENT_SEED`): o Atlas Admin, em toda edição.
  repository.seedOnce(AGENT_SEED, 'seed')
  applyAgentMigrations(repository)
  // ⚖️ Na lite, a semente (o Atlas) perde uma vez as ferramentas do MCP do gateway que a lite não registra: na tela e na
  // conversa, ele só tem o que existe. Vale para a instalação nova e para a que passou a ser lite.
  if (gatewayEdition() === 'lite')
    // A família Atlas (o dos usuários ainda existe nas instalações de antes): as marcas da lite valem para os dois.
    for (const { id } of ATLAS_AGENTS) {
      repository.migrateOnce(
        'lite-tools',
        id,
        (agent) => {
          const allowedTools = withoutLiteTools(agent.allowedTools)
          return allowedTools.length === agent.allowedTools.length ? undefined : { ...agent, allowedTools }
        },
        'seed',
      )
      // E o prompt: o da lite, só no que ainda é o da semente (o que quem administra editou fica como está).
      repository.migrateOnce(
        'lite-prompt',
        id,
        (agent) => {
          const systemPrompt = atlasLitePrompt(agent)
          return systemPrompt ? { ...agent, systemPrompt } : undefined
        },
        'seed',
      )
      // E os triggers: saem os que mandam usar ferramenta que a lite não tem (ver `LITE_HIDDEN_TRIGGERS`).
      repository.migrateOnce(
        'lite-triggers',
        id,
        (agent) => {
          const triggers = withoutLiteTriggers(agent.triggers ?? [])
          return triggers.length === (agent.triggers ?? []).length ? undefined : { ...agent, triggers }
        },
        'seed',
      )
    }

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
  catalog.history.use(() => makeCatalogHistory())
  catalog.useFiles(makeResourceFiles())
  // ⛔ Toda troca do `sharedWith` (rota, restaurar, import, mudar de dono, apagar) apaga os valores secretos de quem saiu.
  catalog.useShares({ exists: (projectId) => makeProjects().exists(projectId), changed: (agentId, projects) => makeResourceSecrets().keepAgentProjects(agentId, projects) })
  // 🔌 A camada local do agente de projeto conectado entra no agente que roda (pedida na hora: a fábrica dela usa esta).
  catalog.useLocalLayers((agent) => makeAgentLocalLayers().of(agent))
  instance = catalog
  return catalog
}

/** O repositório dos agentes, para o leitor do catálogo (o histórico lê o agente como gravado). */
export function agentRepository(): IAgentRepository {
  makeAgents()
  return stored!
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
  // O do Atlas; na lite, que não tem o Atlas dos usuários, o do Atlas Admin.
  const atlas = catalog.list().find((agent) => agent.id === 'atlas') ?? catalog.list().find((agent) => agent.id === 'atlas-admin')
  const fallback = atlas ? targetFor(atlas, undefined, undefined, (target) => catalog.isTargetRunnable(atlas, target)) : undefined
  const chosen = settings?.builderProvider && settings.builderModel ? { provider: settings.builderProvider, model: settings.builderModel } : fallback
  if (!chosen) return []
  const target = { provider: chosen.provider, models: [chosen.model] }
  // O construtor de cada tipo e a variante dele em modo importação (sem gravar), no mesmo modelo.
  return (Object.keys(PROTOCOLS) as TProtocolKind[]).flatMap((kind) => [builderAgent(kind, target), importBuilderAgent(kind, target)])
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
