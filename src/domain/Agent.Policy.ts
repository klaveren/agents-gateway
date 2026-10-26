import { EMode } from './enums/EMode.Enum'
import { isSubscription, lanesOf, nativeFamily } from './Subscription.Policy'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent } from './models/Agent.Model'
import { INativeTool, isNativeTool, nativeTool, nativeToolAllowed } from './Native.Tools'
import { REASONING_LEVELS } from './Reasoning.Levels'
import { isMcpToolRef, parseMcpToolRef } from './models/McpServer.Model'
import { AGENT_TOOL_PREFIX, isAgentToolRef } from './models/Delegation.Model'

/** Minúsculas, dígitos e hífen; começa por letra ou dígito. Vira parte de URL e de nome no ADK. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const AGENT_NAME_MAX = 80
export const AGENT_PROMPT_MAX = 20_000
export const AGENT_SOUL_MAX = 8_000

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
  /** Ids que já existem e não podem ser tomados (na criação, todos os agentes). */
  takenIds: readonly string[]
  /**
   * As tools que um agente criado PODE receber.
   *
   * ⛔ É O PERÍMETRO DE `LOCAL_TOOLS_ENABLED` CONTINUANDO: quem tira o `run_bash` da lista o tira do
   * gateway, e uma tela que deixasse dá-lo a um agente desfaria isso por baixo (ver `localToolPerimeter`).
   */
  knownTools: readonly string[]
  /** De qual oficial é um modelo, pelo id. Só vale sem `modelEnabled` (o catálogo é a regra). */
  providerOf?(model: string): EProvider | undefined
  /**
   * O protocolo do provider configurado, ou `undefined` se ele não existe. Ausente = só os três
   * oficiais existem (id igual ao protocolo).
   */
  protocolOf?(providerId: string): EProvider | undefined
  /**
   * O modelo está ATIVADO no catálogo do provider? Presente, é a regra dos modelos (e o palpite pelo
   * prefixo do id deixa de valer): agente só oferece modelo que alguém ativou em Providers.
   */
  modelEnabled?(providerId: string, modelId: string): boolean
  /**
   * O servidor MCP existe? (`mcp:<servidor>/…`). Ausente = nenhum servidor cadastrado, e toda referência
   * a MCP é recusada.
   */
  mcpServerExists?(serverId: string): boolean
  /** O agente existe? (`agent:<id>`, a quem este pode delegar). Ausente = nenhuma delegação vale. */
  agentExists?(agentId: string): boolean
  /** O perímetro das nativas. Ausente = `nativeToolAllowed` com o ambiente do processo. */
  nativeAllowed?(tool: INativeTool): boolean
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
  // ⚖️ Só nos OFICIAIS o id do modelo diz de quem ele é. Num compatível (que pode servir modelos de
  // vários fabricantes, com ids próprios) qualquer id é plausível — quem confere é o catálogo de modelos do provider.
  // Os de assinatura conferem pelo catálogo (o id do modelo não diz de quem ele é: o Antigravity serve Claude).
  const official = protocol !== undefined && protocol === agent.provider && !isSubscription(protocol)
  if (protocol && rules.modelEnabled) {
    for (const model of agent.models) if (!rules.modelEnabled(agent.provider, model)) issue('models', `not enabled in Providers → Models: ${model}`)
  } else if (official && rules.providerOf) {
    for (const model of agent.models) {
      const provider = rules.providerOf(model)
      if (provider !== protocol) issue('models', provider ? `${model} is a ${provider} model` : `unknown model: ${model}`)
    }
  }

  // ⚠️ Nível que o protocolo não aceita seria descartado em silêncio pelo adapter: a pessoa escolheria
  // "xhigh" e receberia o padrão. Recusa-se aqui. No Google não há nível nenhum (ver `REASONING_LEVELS`).
  if (protocol) {
    for (const level of agent.reasoningEfforts ?? []) {
      if (REASONING_LEVELS[protocol].includes(level)) continue
      issue('reasoningEfforts', REASONING_LEVELS[protocol].length ? `${level} is not a ${protocol} reasoning level` : `${protocol} has no reasoning control here`)
    }
  }

  if (!agent.modes.length) issue('modes', 'at least one lane')
  for (const mode of agent.modes) if (!Object.values(EMode).includes(mode)) issue('modes', `unknown lane: ${String(mode)}`)
  // ⛔ Assinatura só tem a lane agent: as APIs de chat exigem chave (ver `Subscription.Policy`).
  if (protocol) for (const mode of agent.modes) if (!lanesOf(protocol).includes(mode)) issue('modes', `${protocol} runs only in the agent lane`)

  for (const tool of agent.allowedTools) {
    // ⚖️ MCP: o servidor tem de existir; a ferramenta, não — o servidor pode estar fora do ar ao salvar.
    // ⛔ Delegação: a outro agente que exista — nunca a si mesmo (a volta mais curta de uma recursão).
    if (isAgentToolRef(tool)) {
      const target = tool.slice(AGENT_TOOL_PREFIX.length)
      if (!target) issue('allowedTools', `invalid delegation (use agent:<id>): ${tool}`)
      else if (target === agent.id) issue('allowedTools', 'an agent cannot delegate to itself')
      else if (!rules.agentExists?.(target)) issue('allowedTools', `unknown agent to delegate to: ${target}`)
      continue
    }
    if (isMcpToolRef(tool)) {
      const ref = parseMcpToolRef(tool)
      if (!ref) issue('allowedTools', `invalid MCP tool (use mcp:<server>/<tool> or mcp:<server>/*): ${tool}`)
      else if (!rules.mcpServerExists?.(ref.server)) issue('allowedTools', `unknown MCP server: ${ref.server}`)
      continue
    }
    if (!isNativeTool(tool)) {
      if (!rules.knownTools.includes(tool)) issue('allowedTools', `not available: ${tool}`)
      continue
    }

    // ⛔ Nativa: tem de ser do SDK deste provider, estar no perímetro do deploy e, se exigir, o provider ser o oficial.
    const native = nativeTool(tool)
    if (!native) issue('allowedTools', `unknown SDK tool: ${tool}`)
    else if (native.protocol !== (protocol && nativeFamily(protocol))) issue('allowedTools', `${native.label} is a ${native.protocol} SDK tool`)
    else if (!(rules.nativeAllowed ?? nativeToolAllowed)(native)) issue('allowedTools', `blocked by NATIVE_TOOLS_ENABLED: ${tool}`)
    else if (native.officialOnly && !official) issue('allowedTools', `${native.label} works only with the official provider`)
  }

  if (agent.soul && agent.soul.length > AGENT_SOUL_MAX) issue('soul', `at most ${AGENT_SOUL_MAX} characters`)

  if (!agent.systemPrompt.trim()) issue('systemPrompt', 'required')
  else if (agent.systemPrompt.length > AGENT_PROMPT_MAX) issue('systemPrompt', `at most ${AGENT_PROMPT_MAX} characters`)
  else {
    const promptIssue = rules.promptIssue?.(agent)
    if (promptIssue) issue('systemPrompt', promptIssue)
  }

  return issues
}

/**
 * O modelo pedido, se AQUELE agente o declara. Senão, o primeiro que ele declara.
 *
 * ⛔ AGENTE E MODELO SÃO CAMPOS INDEPENDENTES NA CONFIGURAÇÃO, e não são coisas independentes na
 * realidade. Trocar o agente para outro provider com o modelo do anterior gravado mandava um modelo
 * de um provider para o outro — e o erro que voltava ("modelo inexistente ou sem acesso") manda
 * procurar permissão quando o problema é uma combinação impossível.
 *
 * O guard fica no caminho de APLICAÇÃO, e não só ao salvar: configuração gravada antes dele continua
 * existindo, e não pode derrubar a sessão de ninguém. Sem modelo pedido, devolve `undefined` e o
 * adapter usa o seu padrão.
 */
export function modelFor(agent: IAgent, model?: string): string | undefined {
  // Sem modelo pedido, o padrão do agente (o primeiro) — não há mais modelo padrão no adapter.
  if (!model) return agent.models[0]

  return agent.models.includes(model) ? model : agent.models[0]
}
