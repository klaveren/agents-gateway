import { ATLAS_BUILDERS_SECTION, BUILDER_DELEGATIONS, RETIRED_ATLAS_TOOLS } from './Agent.Seed'
import { IAgent } from './models/Agent.Model'

/** Uma mudança que o gateway aplica UMA VEZ num agente da semente que já está no banco (ver `migrateOnce`). */
export interface IAgentMigration {
  key: string
  agentIds: readonly string[]
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
]
