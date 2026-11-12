import {
  ATLAS_ADMIN_AGENT_LINE,
  ATLAS_ADMIN_BUILDERS_RULE,
  ATLAS_ADMIN_LITE_PROMPT,
  ATLAS_ADMIN_PERMISSIONS,
  ATLAS_ADMIN_PROMPT,
  ATLAS_ALL_GATEWAY_TOOLS,
  ATLAS_IMPORT_LINE,
  ATLAS_INSTALL_REFERENCE,
  ATLAS_PERMISSIONS,
  ATLAS_SCHEDULES_SECTION,
  ATLAS_AGENT_LINE,
  ATLAS_BUILDERS_SECTION,
  ATLAS_KNOWLEDGE_LINE,
  ATLAS_MIGRATION_SECTION,
  ATLAS_TALK_LINE,
  ATLAS_TRIGGERS,
  BUILDER_DELEGATIONS,
  LEGACY_ATLAS_ADMIN_LITE_PROMPT,
  LEGACY_ATLAS_ADMIN_PROMPT,
  LEGACY_ATLAS_BUILDERS_RULE,
  LEGACY_ATLAS_TRIGGER_SECTIONS,
  RETIRED_ATLAS_AGENT_TOOL,
  RETIRED_ATLAS_TOOLS,
} from './Agent.Seed'
import { IAgent } from './models/Agent.Model'
import { UPDATE_TODOS_TOOL } from './models/ConversationTodo.Model'
import { toCapabilities } from './Capability.Catalog'
import { EProvider } from './enums/EProvider.Enum'
import { gatewayEdition, TEdition } from './Edition.Policy'

/** A nativa que saiu do catálogo (a lista de tarefas agora é do gateway). */
export const RETIRED_TODO_NATIVE = 'sdk:TodoWrite'

/** Uma mudança que o gateway aplica UMA VEZ num agente que já está no banco (ver `migrateOnce`). */
export interface IAgentMigration {
  key: string
  /** Os agentes da semente que ela toca; `'*'` = todos os que existem no banco quando o gateway sobe. */
  agentIds: readonly string[] | '*'
  change: (agent: IAgent) => IAgent | undefined
}

const hasTrigger = (agent: IAgent, id: string) => (agent.triggers ?? []).some((trigger) => trigger.id === id)

/**
 * O prompt do Atlas Admin depois que as seções viraram trigger. O da semente de antes, intacto, vira o de hoje. O que
 * quem administra mexeu perde só as seções que AINDA são idênticas às de antes (a editada fica, é dele) e ganha no fim
 * as duas linhas novas (na lite, só a de conversar: ela não tem o importador).
 */
export function atlasTriggersPrompt(prompt: string, edition: TEdition = gatewayEdition()): string {
  if (prompt === LEGACY_ATLAS_ADMIN_PROMPT) return ATLAS_ADMIN_PROMPT
  if (prompt === LEGACY_ATLAS_ADMIN_LITE_PROMPT) return ATLAS_ADMIN_LITE_PROMPT
  let next = prompt
  for (const section of LEGACY_ATLAS_TRIGGER_SECTIONS) next = next.split(section).join('')
  // Sem a seção de instalar, a frase que apontava para ela aponta para o trigger.
  if (edition !== 'lite' && !next.includes('## Instalar o que falta')) next = next.replace(ATLAS_INSTALL_REFERENCE.legacy, ATLAS_INSTALL_REFERENCE.current)
  next = next.replace(ATLAS_AGENT_LINE, ATLAS_ADMIN_AGENT_LINE).replace(LEGACY_ATLAS_BUILDERS_RULE, ATLAS_ADMIN_BUILDERS_RULE)
  if (next !== prompt) next = next.replace(/\n{3,}/g, '\n\n').trimEnd()
  const lines = [...(next.includes('start_conversation') ? [] : [ATLAS_TALK_LINE]), ...(edition === 'lite' || next.includes('migrate-environment') ? [] : [ATLAS_IMPORT_LINE])]
  return lines.length ? `${next.trimEnd()}\n\n${lines.join('\n')}` : next
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
    // Quem já tem o trigger `create-schedule` (o Atlas Admin de hoje) sabe por ele: a seção não volta ao prompt.
    change: (agent) =>
      agent.systemPrompt.includes('save_schedule') || hasTrigger(agent, 'create-schedule')
        ? undefined
        : { ...agent, systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n## Agendamentos\n${ATLAS_SCHEDULES_SECTION}` },
  },
  {
    // Migrar um ambiente: o Atlas que já existe aprende o fluxo (as ferramentas, `import_items`, chegam pela semente).
    key: 'atlas-migration',
    agentIds: ['atlas', 'atlas-admin'],
    // Idem com o trigger `migrate-environment`.
    change: (agent) =>
      agent.systemPrompt.includes('## Migrar um ambiente para o gateway') || hasTrigger(agent, 'migrate-environment')
        ? undefined
        : { ...agent, systemPrompt: `${agent.systemPrompt.trimEnd()}\n\n${ATLAS_MIGRATION_SECTION}` },
  },
  {
    // ⚖️ O QUE O ATLAS ADMIN SABE FAZER saiu do prompt e virou TRIGGER (migrar, preços, hooks, agendamentos, instalar):
    // o que já existe ganha os cinco (id que ele já tem não é sobrescrito) e perde as seções que ainda são as da semente.
    // "Todas as ferramentas" do gateway chega pela semente; aqui só saem as listadas uma a uma, que ela já cobre.
    // O Atlas dos usuários (aposentado) fica como está.
    key: 'atlas-triggers',
    agentIds: ['atlas-admin'],
    change: (agent) => {
      const triggers = [...(agent.triggers ?? []), ...ATLAS_TRIGGERS.filter((trigger) => !hasTrigger(agent, trigger.id))]
      const systemPrompt = atlasTriggersPrompt(agent.systemPrompt)
      const allowedTools = agent.allowedTools.includes(ATLAS_ALL_GATEWAY_TOOLS)
        ? agent.allowedTools.filter((tool) => tool === ATLAS_ALL_GATEWAY_TOOLS || !tool.startsWith('mcp:gateway/'))
        : agent.allowedTools
      const same = triggers.length === (agent.triggers ?? []).length && systemPrompt === agent.systemPrompt && allowedTools.length === agent.allowedTools.length
      return same ? undefined : { ...agent, triggers, systemPrompt, allowedTools }
    },
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
    // Os CLIs por assinatura passaram a rodar com o sandbox fixo: o Codex sempre só leitura e sem terminal (o terminal e
    // os arquivos são os do gateway, por MCP); o Gemini sempre com `--sandbox`. O nível e a rede escolhidos saem.
    key: 'cli-fixed-sandbox',
    agentIds: '*',
    change: (agent) => {
      const fixed = (provider: string) => provider === EProvider.CODEX || provider === EProvider.ANTIGRAVITY
      if (!agent.providers.some((target) => fixed(target.provider) && (target.sandbox !== undefined || target.network !== undefined))) return undefined
      const providers = agent.providers.map((target) => {
        if (!fixed(target.provider)) return target
        const { sandbox: _sandbox, network: _network, ...rest } = target
        return rest
      })
      return { ...agent, providers }
    },
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
