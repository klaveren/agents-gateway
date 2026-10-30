import { permissionIssues } from './Permission.Policy'
import { capability, isCapability } from './Capability.Catalog'
import { EMode } from './enums/EMode.Enum'
import { SANDBOX_NETWORK, sandboxLevelsOf } from './Sandbox.Policy'
import { isSubscription, lanesOf, nativeFamily } from './Subscription.Policy'
import { EProvider } from './enums/EProvider.Enum'
import { IAgent, IAgentTarget, IAgentTrigger, TRIGGER_ID_PATTERN } from './models/Agent.Model'
import { isNativeTool, nativeTool } from './Native.Tools'
import { REASONING_LEVELS } from './Reasoning.Levels'
import { isMcpToolRef, parseMcpToolRef } from './models/McpServer.Model'
import { AGENT_TOOL_PREFIX, isAgentToolRef } from './models/Delegation.Model'

/** Minúsculas, dígitos e hífen; começa por letra ou dígito. Vira parte de URL e de nome no ADK. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
export const AGENT_NAME_MAX = 80
/**
 * ⚖️ O TAMANHO DO PROMPT É DE QUEM CRIA O AGENTE: o sistema não impõe teto (custa tokens a cada turno, e a tela mostra
 * quanto). A trava que existe é técnica: o Codex e o Antigravity recebem o prompt como ARGUMENTO de linha de comando, e
 * o Linux recusa um argumento acima de 128 KiB (`MAX_ARG_STRLEN`). A conta deixa folga para o que o gateway junta ao
 * prompt (rules, índice de skills e de documentos).
 */
export const CLI_PROMPT_MAX_BYTES = 120_000
/** As lanes que passam o prompt como argumento de linha de comando. */
const CLI_PROMPT_PROTOCOLS: readonly string[] = [EProvider.CODEX, EProvider.ANTIGRAVITY]

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

  for (const item of permissionIssues(agent.permissions)) issue(item.field, item.message)
  // A cadeia própria só com o que o agente oferece: um passo de fora nunca rodaria (ver `Fallback.Policy`).
  for (const step of agent.fallback?.mode === 'own' ? (agent.fallback.chain ?? []) : [])
    if (!offers(agent, step.provider, step.model)) issue('fallback', `not offered by this agent: ${step.provider} / ${step.model}`)
  if (!AGENT_ID_PATTERN.test(agent.id)) issue('id', 'use 2–48 lowercase letters, digits or hyphens')
  else if (rules.takenIds.includes(agent.id)) issue('id', `already exists: ${agent.id}`)

  if (!agent.name.trim()) issue('name', 'required')
  else if (agent.name.length > AGENT_NAME_MAX) issue('name', `at most ${AGENT_NAME_MAX} characters`)

  // Cada provider do agente, com o protocolo resolvido (ausente = provider desconhecido).
  const providers = agent.providers ?? []
  const targets = providers.map((target) => {
    const protocol = rules.protocolOf ? rules.protocolOf(target.provider) : Object.values(EProvider).find((value) => value === target.provider)
    // ⚖️ Só nos OFICIAIS o id do modelo diz de quem ele é. Num compatível (que pode servir modelos de
    // vários fabricantes, com ids próprios) qualquer id é plausível — quem confere é o catálogo de modelos do provider.
    // Os de assinatura conferem pelo catálogo (o id do modelo não diz de quem ele é: o Antigravity serve Claude).
    const official = protocol !== undefined && protocol === target.provider && !isSubscription(protocol)
    return { ...target, protocol, official }
  })

  if (!targets.length) issue('providers', 'at least one provider')
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.provider)) issue('providers', `listed twice: ${target.provider}`)
    seen.add(target.provider)
    if (!target.protocol) issue('providers', `unknown provider: ${String(target.provider)}`)

    if (target.protocol && target.sandbox !== undefined && !sandboxLevelsOf(target.protocol).includes(target.sandbox))
      issue('providers', sandboxLevelsOf(target.protocol).length ? `${target.provider}: not a sandbox level here: ${target.sandbox}` : `${target.provider}: has no sandbox to set`)
    if (target.protocol && target.network && !SANDBOX_NETWORK.includes(target.protocol)) issue('providers', `${target.provider}: has no sandbox network to open`)

    if (!target.models.length) issue('models', `${target.provider}: at least one model`)
    if (target.protocol && rules.modelEnabled) {
      for (const model of target.models) if (!rules.modelEnabled(target.provider, model)) issue('models', `${target.provider}: not enabled in Providers → Models: ${model}`)
    } else if (target.official && rules.providerOf) {
      for (const model of target.models) {
        const provider = rules.providerOf(model)
        if (provider !== target.protocol) issue('models', provider ? `${model} is a ${provider} model` : `unknown model: ${model}`)
      }
    }
  }
  const protocols = targets.flatMap((target) => (target.protocol ? [target.protocol] : []))

  // ⚠️ Nível que nenhum protocolo do agente aceita seria descartado em silêncio pelo adapter: a pessoa
  // escolheria "xhigh" e receberia o padrão. Recusa-se aqui. Com vários providers, cada um usa os níveis
  // que o seu protocolo aceita — basta valer em um. No Google não há nível nenhum (ver `REASONING_LEVELS`).
  if (protocols.length) {
    for (const level of agent.reasoningEfforts ?? []) {
      if (protocols.some((protocol) => REASONING_LEVELS[protocol].includes(level))) continue
      const known = protocols.filter((protocol) => REASONING_LEVELS[protocol].length)
      issue('reasoningEfforts', known.length ? `${level} is not a reasoning level of ${known.join(', ')}` : `${protocols.join(', ')} has no reasoning control here`)
    }
  }

  if (!agent.modes.length) issue('modes', 'at least one lane')
  for (const mode of agent.modes) if (!Object.values(EMode).includes(mode)) issue('modes', `unknown lane: ${String(mode)}`)
  // ⛔ Assinatura só tem a lane agent: as APIs de chat exigem chave (ver `Subscription.Policy`). A lane
  // precisa de ao menos um provider que a rode; a sessão só troca para os que rodam a lane dela.
  if (protocols.length)
    for (const mode of agent.modes) if (!protocols.some((protocol) => lanesOf(protocol).includes(mode))) issue('modes', `${protocols.join(', ')} runs only in the agent lane`)

  for (const tool of agent.allowedTools) {
    // Capacidade (`cap:terminal`…): basta existir — o que roda em cada provedor é decidido no turno (`Capability.Catalog`).
    // ⛔ O perímetro do servidor (`LOCAL_TOOLS_ENABLED`) vale para ela: sem nenhuma das ferramentas do gateway que a
    // implementam, a capacidade não está disponível.
    if (isCapability(tool)) {
      const item = capability(tool)
      if (!item) issue('allowedTools', `unknown capability: ${tool}`)
      else if (item.local.length && !item.local.some((local) => rules.knownTools.includes(local))) issue('allowedTools', `not available: ${item.label}`)
      continue
    }
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

    // ⛔ Nativa: tem de ser do SDK de um provider do agente e, se exigir, haver um provider OFICIAL daquela
    // família. Nos outros providers ela não vai (os adapters filtram pela família).
    const native = nativeTool(tool)
    const family = native && targets.filter((target) => target.protocol && nativeFamily(target.protocol) === native.protocol)
    if (!native || !family) issue('allowedTools', `unknown SDK tool: ${tool}`)
    else if (!family.length) issue('allowedTools', `${native.label} is a ${native.protocol} SDK tool`)
    else if (native.officialOnly && !family.some((target) => target.official)) issue('allowedTools', `${native.label} works only with the official provider`)
  }

  for (const item of triggerIssues(agent.triggers)) issue(item.field, item.message)

  if (!agent.systemPrompt.trim()) issue('systemPrompt', 'required')
  else {
    const bytes = Buffer.byteLength(agent.systemPrompt) + Buffer.byteLength(agent.soul ?? '')
    const cli = targets.filter((target) => target.protocol && CLI_PROMPT_PROTOCOLS.includes(target.protocol)).map((target) => target.provider)
    if (cli.length && bytes > CLI_PROMPT_MAX_BYTES)
      issue(
        'systemPrompt',
        `${cli.join(', ')} receive the prompt as a command-line argument, and Linux refuses one above 128 KiB: keep soul + prompt under ${CLI_PROMPT_MAX_BYTES / 1000} KB (now ${Math.round(bytes / 1000)} KB) or remove those providers from this agent`,
      )

    const promptIssue = rules.promptIssue?.(agent)
    if (promptIssue) issue('systemPrompt', promptIssue)
  }

  return issues
}

/** O que está errado nos triggers de um agente: id em slug e único, "quando" numa linha só, corpo obrigatório. */
export function triggerIssues(triggers: readonly IAgentTrigger[] | undefined): IAgentIssue[] {
  const issues: IAgentIssue[] = []
  const issue = (message: string) => issues.push({ field: 'triggers', message })
  const ids = new Set<string>()
  for (const trigger of triggers ?? []) {
    if (!TRIGGER_ID_PATTERN.test(trigger.id ?? '')) issue(`id "${trigger.id}": lowercase letters, digits and hyphens, 2 to 64`)
    else if (ids.has(trigger.id)) issue(`id "${trigger.id}" listed twice`)
    ids.add(trigger.id)
    if (!trigger.when?.trim()) issue(`${trigger.id}: when is required (one line: when to use it)`)
    else if (/\n/.test(trigger.when.trim())) issue(`${trigger.id}: when is one line`)
    if (!trigger.body?.trim()) issue(`${trigger.id}: body is required`)
  }
  return issues
}

/** O provider e o modelo de uma sessão. */
export interface IAgentChoice {
  provider: string
  model: string
}

/** O agente oferece este modelo NESTE provider? */
export function offers(agent: IAgent, provider: string, model: string): boolean {
  return agent.providers.some((target) => target.provider === provider && target.models.includes(model))
}

/** Todos os pares provider + modelo do agente, o padrão primeiro. */
export function choicesOf(agent: IAgent): IAgentChoice[] {
  return agent.providers.flatMap((target) => target.models.map((model) => ({ provider: target.provider, model })))
}

/**
 * O provider e o modelo pedidos, se AQUELE agente os declara. Senão, o padrão: o primeiro modelo do
 * primeiro provider (que tenha modelo).
 *
 * ⛔ AGENTE E MODELO SÃO CAMPOS INDEPENDENTES NA CONFIGURAÇÃO, e não são coisas independentes na
 * realidade. Trocar o agente para outro provider com o modelo do anterior gravado mandava um modelo
 * de um provider para o outro — e o erro que voltava ("modelo inexistente ou sem acesso") manda
 * procurar permissão quando o problema é uma combinação impossível.
 *
 * O guard fica no caminho de APLICAÇÃO, e não só ao salvar: configuração gravada antes dele continua
 * existindo, e não pode derrubar a sessão de ninguém.
 *
 * Só o modelo, sem provider: o primeiro provider que o oferece. Só o provider: o primeiro modelo dele.
 * `usable` restringe a busca (ex.: só os providers que podem rodar agora); o padrão cai no primeiro que passa.
 */
export function targetFor(agent: IAgent, provider?: string, model?: string, usable: (target: IAgentTarget) => boolean = () => true): IAgentChoice | undefined {
  const candidates = agent.providers.filter((target) => target.models.length && usable(target))
  const match =
    (provider && model && candidates.find((target) => target.provider === provider && target.models.includes(model))) ||
    (!provider && model && candidates.find((target) => target.models.includes(model))) ||
    (provider && !model && candidates.find((target) => target.provider === provider))
  if (match) return { provider: match.provider, model: model && match.models.includes(model) ? model : match.models[0] }

  const fallback = candidates[0]
  return fallback ? { provider: fallback.provider, model: fallback.models[0] } : undefined
}

/**
 * O que o adapter grava ao criar a sessão: o provider e o modelo que o `AgentProvider` já resolveu (e
 * conferiu), ou — quem chama o adapter direto — o padrão do agente.
 */
export function sessionChoice(agent: IAgent, input: { provider?: string; model?: string }): IAgentChoice {
  const provider = input.provider || agent.providers[0]?.provider || ''
  const model = input.model || agent.providers.find((target) => target.provider === provider)?.models[0] || ''
  return { provider, model }
}
