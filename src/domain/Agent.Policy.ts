import { EMode } from './enums/EMode.Enum'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'

/** Minúsculas, dígitos e hífen; começa por letra ou dígito. Vira parte de URL e de nome no ADK. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const AGENT_NAME_MAX = 80
export const AGENT_PROMPT_MAX = 20_000

export interface IAgentIssue {
  field: string
  message: string
}

/**
 * O que a regra precisa saber de fora para julgar um agente.
 *
 * ⚖️ INJETADO, e não importado: quais tools existem vem do catálogo (infra), de que provider é um
 * modelo vem do classificador de ids (infra), e o que o ADK recusa num prompt é detalhe do adapter.
 * A regra é daqui; os fatos, de quem os conhece.
 */
export interface IAgentRules {
  /** Ids que já existem e não podem ser tomados — os embutidos e, na criação, os criados. */
  takenIds: readonly string[]
  /**
   * As tools que um agente criado PODE receber.
   *
   * ⛔ É O PERÍMETRO DE `AGENTS_ENABLED` CONTINUANDO: quem tira o `sysops-agent` da lista tira o
   * `run_bash` do gateway, e uma tela que deixasse dar `run_bash` a um agente novo desfaria isso
   * por baixo. Só entra aqui tool local que algum embutido HABILITADO já tem, mais as do MCP.
   */
  knownTools: readonly string[]
  providerOf(model: string): EProvider | undefined
  /**
   * O protocolo do provider configurado, ou `undefined` se ele não existe. Ausente = só os três
   * oficiais existem (id igual ao protocolo).
   */
  protocolOf?(providerId: string): EProvider | undefined
  /** Problema do prompt para aquele provider (ex.: chaves que o ADK lê como variável). */
  promptIssue?(agent: IAgent): string | undefined
}

/**
 * Tudo o que está errado num agente, de uma vez — a tela mostra campo a campo.
 *
 * ⚠️ O MODELO TEM DE SER DO PROVIDER. Um `gpt-*` num agente Google não falha ao salvar: falha na
 * primeira mensagem, com um "modelo inexistente" que manda procurar permissão. Recusa-se aqui, onde
 * a causa está à vista. Modelo cujo provider não se reconhece também é recusado, pelo mesmo motivo.
 */
export function agentIssues(agent: IAgent, rules: IAgentRules): IAgentIssue[] {
  const issues: IAgentIssue[] = []
  const issue = (field: string, message: string) => issues.push({ field, message })

  if (!AGENT_ID_PATTERN.test(agent.id)) issue('id', 'use 2–48 lowercase letters, digits or hyphens')
  else if (rules.takenIds.includes(agent.id)) issue('id', `already exists: ${agent.id}`)

  if (!agent.name.trim()) issue('name', 'required')
  else if (agent.name.length > AGENT_NAME_MAX) issue('name', `at most ${AGENT_NAME_MAX} characters`)

  const protocol = rules.protocolOf ? rules.protocolOf(agent.provider) : Object.values(EProvider).find((value) => value === agent.provider)
  if (!protocol) issue('provider', `unknown provider: ${String(agent.provider)}`)

  if (!agent.models.length) issue('models', 'at least one model')
  // ⚖️ Só nos OFICIAIS o id do modelo diz de quem ele é. Num compatível (OpenRouter: `anthropic/…`,
  // `meta-llama/…`) qualquer id é plausível — quem confere é o catálogo de modelos do provider.
  const official = protocol !== undefined && protocol === agent.provider
  if (official) {
    for (const model of agent.models) {
      const provider = rules.providerOf(model)
      if (provider !== protocol) issue('models', provider ? `${model} is a ${provider} model` : `unknown model: ${model}`)
    }
  }

  if (!agent.modes.length) issue('modes', 'at least one lane')
  for (const mode of agent.modes) if (!Object.values(EMode).includes(mode)) issue('modes', `unknown lane: ${String(mode)}`)

  for (const tool of agent.allowedTools) if (!rules.knownTools.includes(tool)) issue('allowedTools', `not available: ${tool}`)

  if (!agent.systemPrompt.trim()) issue('systemPrompt', 'required')
  else if (agent.systemPrompt.length > AGENT_PROMPT_MAX) issue('systemPrompt', `at most ${AGENT_PROMPT_MAX} characters`)
  else {
    const promptIssue = rules.promptIssue?.(agent)
    if (promptIssue) issue('systemPrompt', promptIssue)
  }

  return issues
}
