import {
  ATLAS_ADMIN_PERMISSIONS,
  ATLAS_PERMISSIONS,
  ATLAS_SCHEDULES_SECTION,
  ATLAS_AGENT_LINE,
  ATLAS_BUILDERS_SECTION,
  ATLAS_KNOWLEDGE_LINE,
  BUILDER_DELEGATIONS,
  RETIRED_ATLAS_AGENT_TOOL,
  RETIRED_ATLAS_TOOLS,
} from './Agent.Seed'
import { IAgent } from './models/Agent.Model'
import { UPDATE_TODOS_TOOL } from './models/ConversationTodo.Model'
import { toCapabilities } from './Capability.Catalog'

/** A nativa que saiu do catálogo (a lista de tarefas agora é do gateway). */
export const RETIRED_TODO_NATIVE = 'sdk:TodoWrite'

/** Uma mudança que o gateway aplica UMA VEZ num agente que já está no banco (ver `migrateOnce`). */
export interface IAgentMigration {
  key: string
  /** Os agentes da semente que ela toca; `'*'` = todos os que existem no banco quando o gateway sobe. */
  agentIds: readonly string[] | '*'
  change: (agent: IAgent) => IAgent | undefined
}

/**
 * ⚖️ A SEMENTE SÓ ACRESCENTA (`seedOnce`): tirar uma ferramenta ou mudar o modo de trabalhar de um agente que já existe
 * pede uma migração explícita, nomeada e única. O resto do agente (modelos, alma, o prompt que quem administra
 * escreveu) fica como está.
 */
export const AGENT_MIGRATIONS: readonly IAgentMigration[] = [
  {
    // O Atlas deixou de gravar conteúdo: delega ao construtor do tipo, que segue o protocolo do core.
    key: 'atlas-builders',
    agentIds: ['atlas', 'atlas-admin'],
    change: (agent) => {
      const tools = agent.allowedTools.filter((tool) => !RETIRED_ATLAS_TOOLS.includes(tool))
      const allowedTools = [...tools, ...BUILDER_DELEGATIONS.filter((tool) => !tools.includes(tool))]
      // A seção vai no fim do prompt de quem já existe, para ele saber o que fazer com as ferramentas novas.
      const systemPrompt = agent.systemPrompt.includes('builder-skill') ? agent.systemPrompt : `${agent.systemPrompt.trimEnd()}\n\n${ATLAS_BUILDERS_SECTION}`
      const same = systemPrompt === agent.systemPrompt && allowedTools.length === agent.allowedTools.length && allowedTools.every((tool) => agent.allowedTools.includes(tool))
      return same ? undefined : { ...agent, allowedTools, systemPrompt }
    },
  },
  {
    // O construtor de conhecimento chegou depois: o Atlas que já tinha a seção dos construtores aprende a delegar a ele.
    // (A delegação `agent:builder-knowledge` chega pela semente.)
    key: 'atlas-knowledge',
    agentIds: ['atlas', 'atlas-admin'],
    change: (agent) => (agent.systemPrompt.includes('builder-knowledge') ? undefined : { ...agent, systemPrompt: `${agent.systemPrompt.trimEnd()}\n${ATLAS_KNOWLEDGE_LINE}` }),
  },
  {
    // O construtor de agentes: o Atlas deixa de gravar agente (perde o save_agent) e delega criar e ajustar a ele.
    key: 'atlas-agent-builder',
    agentIds: ['atlas', 'atlas-admin'],
    change: (agent) => {
      const allowedTools = agent.allowedTools.filter((tool) => tool !== RETIRED_ATLAS_AGENT_TOOL)
      const systemPrompt = agent.systemPrompt.includes('builder-agent') ? agent.systemPrompt : `${agent.systemPrompt.trimEnd()}\n\n## Agentes\n${ATLAS_AGENT_LINE}`
      return allowedTools.length === agent.allowedTools.length && systemPrompt === agent.systemPrompt ? undefined : { ...agent, allowedTools, systemPrompt }
    },
  },
  {
    // Os agendamentos: o Atlas que já existe aprende a cuidar deles (as ferramentas chegam pela semente).
    key: 'atlas-schedules',
    agentIds: ['atlas', 'atlas-admin'],
    change: (agent) =>
      agent.systemPrompt.includes('save_schedule') ? undefined : { ...agent, systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n## Agendamentos\n${ATLAS_SCHEDULES_SECTION}` },
  },
  {
    // A lista de tarefas passou a ser do gateway: quem tinha a nativa do Claude (`sdk:TodoWrite`) ganha a `update_todos`.
    key: 'todos-native',
    agentIds: '*',
    change: (agent) => {
      if (!agent.allowedTools.includes(RETIRED_TODO_NATIVE)) return undefined
      const tools = agent.allowedTools.filter((tool) => tool !== RETIRED_TODO_NATIVE)
      return { ...agent, allowedTools: tools.includes(UPDATE_TODOS_TOOL) ? tools : [...tools, UPDATE_TODOS_TOOL] }
    },
  },
  {
    // As PERMISSÕES chegaram com "sem regra = negar": o Atlas que já existe ganha as regras de que precisa para gerir o
    // gateway (as ferramentas dele e a delegação aos construtores). Quem já tem regras fica como está.
    key: 'permissions-atlas',
    agentIds: ['atlas', 'atlas-admin'],
    change: (agent) => (agent.permissions?.length ? undefined : { ...agent, permissions: agent.id === 'atlas-admin' ? ATLAS_ADMIN_PERMISSIONS : ATLAS_PERMISSIONS }),
  },
  {
    // As CAPACIDADES: os ids de antes (`run_bash`, `sdk:Read`, `search_web`…) viram `cap:`. O Bash nativo do Claude vira o
    // Terminal do gateway (o `run_bash`, com a trava); o resto roda como antes, decidido no turno.
    key: 'capabilities',
    agentIds: '*',
    change: (agent) => {
      const allowedTools = toCapabilities(agent.allowedTools)
      return allowedTools.length === agent.allowedTools.length && allowedTools.every((tool, index) => tool === agent.allowedTools[index]) ? undefined : { ...agent, allowedTools }
    },
  },
]
