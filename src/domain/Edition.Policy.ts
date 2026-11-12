import type { IAgentTrigger } from './models/Agent.Model'

/**
 * ⚖️ A EDIÇÃO da instalação: nasce com o deploy (`GATEWAY_EDITION=lite`) e não muda. A lite mostra menos (a tela e o MCP
 * do gateway); o que ela não tem não é barrado na API — é apresentação, não plano.
 */
export type TEdition = 'pro' | 'lite'

export function gatewayEdition(env: NodeJS.ProcessEnv = process.env): TEdition {
  return env.GATEWAY_EDITION?.trim().toLowerCase() === 'lite' ? 'lite' : 'pro'
}

/** As ferramentas do MCP do gateway que a lite não registra: o que a tela da lite também não tem. */
export const LITE_HIDDEN_MCP_TOOLS: ReadonlySet<string> = new Set([
  // Projetos
  'list_projects',
  'save_project',
  'set_project_members',
  // Hooks e agendamentos
  'list_hooks',
  'save_hook',
  'delete_hook',
  'hook_deliveries',
  'list_schedules',
  'save_schedule',
  'delete_schedule',
  // Recursos, arquivos e contexto inicial
  'list_resources',
  'save_resource',
  'delete_resource',
  'get_agent_resources',
  'set_agent_resources',
  'attach_resource_files',
  'get_initial_context',
  'set_initial_context',
  'get_agent_initial_context',
  'set_agent_initial_context',
  // Docs, rules e protocolos
  'list_docs',
  'get_doc',
  'save_doc',
  'delete_doc',
  'list_rules',
  'save_rule',
  'delete_rule',
  'move_rule',
  'get_protocol',
  // Pacotes, importação, troca automática de modelo, histórico do catálogo e erros
  'list_packages',
  'search_packages',
  'install_package',
  'remove_package',
  'import_items',
  'resolve_import_issue',
  'list_model_groups',
  'save_model_group',
  'delete_model_group',
  'catalog_history',
  'list_errors',
])

/** As ferramentas do agente sem as do MCP do gateway que a lite não tem (`mcp:gateway/save_hook`…): o resto fica. */
export function withoutLiteTools(tools: readonly string[]): string[] {
  return tools.filter((tool) => !(tool.startsWith('mcp:gateway/') && LITE_HIDDEN_MCP_TOOLS.has(tool.slice('mcp:gateway/'.length))))
}

/**
 * Os triggers da semente do Atlas que a lite não tem: cada um manda usar ferramenta que ela não registra (o importador,
 * hooks, agendamentos, pacotes). Fica o `update-model-prices`.
 */
export const LITE_HIDDEN_TRIGGERS: ReadonlySet<string> = new Set(['migrate-environment', 'create-hook', 'create-schedule', 'install-missing-tool'])

/** Os triggers do agente sem os que a lite não tem; o resto (os que quem administra criou) fica. */
export function withoutLiteTriggers(triggers: readonly IAgentTrigger[]): IAgentTrigger[] {
  return triggers.filter((trigger) => !LITE_HIDDEN_TRIGGERS.has(trigger.id))
}
