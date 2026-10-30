import { CLI_ARG_MAX_BYTES, CLI_ARG_WARN_RATIO, cliArgumentBytes } from '@domain/CliArgument.Policy'
import { EProvider } from '@domain/enums/EProvider.Enum'
import { ambientSection } from '@domain/Ambient.Policy'
import { IAgent } from '@domain/models/Agent.Model'
import { mcpSelection } from '@domain/models/McpServer.Model'
import { READ_DOC_TOOL, SEARCH_DOCS_TOOL } from '@domain/models/ProjectDoc.Model'
import { SEARCH_RESOURCES_TOOL, USE_RESOURCE_TOOL } from '@domain/models/Resource.Model'
import { estimateTokens, toolTokens } from '@domain/Token.Estimate'
import { IEnvironmentParts } from './Guidance.Service'

type TToolShape = { name: string; description?: string; inputSchema?: unknown }

export interface IFootprintItem {
  name: string
  tokens: number
}

export interface IFootprintSection {
  key: string
  label: string
  /** `null`: está no prompt, mas daqui não se mede (as ferramentas nativas do SDK). */
  tokens: number | null
  items?: IFootprintItem[]
  note?: string
}

export interface IAgentFootprint {
  /** O que se mediu (as seções com `tokens: null` ficam de fora). */
  total: number
  /** O projeto em que se mediu: o do agente ou, num global, o pedido. */
  project?: string
  sections: IFootprintSection[]
  /** O prompt como argumento de linha de comando, quando o agente oferece Codex ou Antigravity (ver `CliArgument.Policy`). */
  cli?: ICliFootprint
}

/** O prompt montado que vai num argumento de CLI, em bytes, contra o limite do Linux. */
export interface ICliFootprint {
  /** Os provedores do agente que passam o prompt por argumento. */
  providers: string[]
  /** O argumento inteiro (o maior entre os CLIs do agente: o escape do Codex pesa). */
  bytes: number
  limit: number
  /** A partir daqui, aviso (nunca bloqueio). */
  warnAt: number
  /** Cada parte do prompt, em bytes crus; `bytes` menos a soma delas é o que a montagem acrescenta (separadores, escape). */
  parts: Array<{ key: string; label: string; bytes: number }>
}

export interface IFootprintDeps {
  guidance?: {
    environmentParts(projectId?: string, agentId?: string): IEnvironmentParts
    hasDocs(projectId?: string, agentId?: string): boolean
    hasResources?(agentId?: string): boolean
  }
  /** As ferramentas locais que o agente tem (com a de delegação), como a conversa as recebe. */
  localFor(allowed: readonly string[]): TToolShape[]
  /** As ferramentas de um servidor MCP, pedidas com a credencial de quem está na tela. `undefined` = fora do ar. */
  mcpTools(server: string): Promise<TToolShape[] | undefined>
  /** Os provedores do agente que rodam num CLI (Codex, Antigravity) e os protocolos deles. Vazio ou ausente = sem a conta do CLI. */
  cli?: { providers: string[]; protocols: EProvider[] }
  /** O nome do projeto e a pasta dele, para o "## Ambiente" (como o `AgentProvider` o compõe). Ausentes = só o id, sem pasta. */
  projectName?(projectId: string): string | undefined
  projectDir?(projectId: string): string
}

/**
 * O TAMANHO do agente: o que ele carrega antes da primeira mensagem, parte a parte, em tokens estimados.
 * ⚖️ Monta as MESMAS peças da conversa — o soul, a instrução e o "## Ambiente" como o `composeSystemPrompt` junta, as seções do
 * ambiente do `GuidanceService`, as ferramentas locais e as dos MCPs (com o `read_doc` quando há índice, como o
 * `AgentProvider`) —, para o número bater com o que vai ao modelo, e não com uma reconstrução da tela.
 */
export async function agentFootprint(agent: IAgent, projectId: string | undefined, deps: IFootprintDeps): Promise<IAgentFootprint> {
  const sections: IFootprintSection[] = []
  // As mesmas partes, em texto, para a conta do CLI (que é em bytes, sobre o prompt montado).
  const texts: Array<{ key: string; label: string; text: string }> = []
  const add = (key: string, label: string, text: string | undefined) => {
    if (!text?.trim()) return
    sections.push({ key, label, tokens: estimateTokens(text) })
    texts.push({ key, label, text })
  }

  const soul = agent.soul?.trim()
  add('soul', 'Soul', soul ? `## Quem você é\n${soul}\n\n## Como você trabalha\n` : undefined)
  add('instructions', 'Instrução do sistema', agent.systemPrompt)
  // O "## Ambiente" de uma conversa no projeto, fora de repositório (o repositório e o branch só a conversa sabe).
  const name = projectId ? deps.projectName?.(projectId) : undefined
  const directory = agent.projectId ? deps.projectDir?.(agent.projectId) : undefined
  add(
    'ambient',
    'Ambiente',
    ambientSection({
      agentId: agent.id,
      ...(projectId ? { project: { id: projectId, ...(name ? { name } : {}), own: agent.projectId === projectId } } : {}),
      ...(directory ? { directory } : {}),
    }),
  )

  const parts = deps.guidance?.environmentParts(projectId, agent.id) ?? {}
  add('rules', 'Rules', parts.rules)
  add('projectSpecs', 'Contexto inicial do projeto', parts.projectSpecs)
  add('agentSpecs', 'Contexto inicial do agente', parts.agentSpecs)
  add('skills', 'Índice de skills', parts.skills)
  add('triggers', 'Índice de triggers', parts.triggers)
  add('commands', 'Índice de commands', parts.commands)
  add('index', 'Índice de documentos', parts.index)
  const cli = deps.cli?.protocols.length ? cliFootprint(deps.cli, texts, [parts.protocol, parts.existing]) : undefined

  // As ferramentas que a conversa liga sozinha: `read_doc` com índice, `use_resource` com skill, command ou trigger (como o `AgentProvider`).
  const automatic = [
    ...(deps.guidance?.hasDocs(projectId, agent.id) ? [READ_DOC_TOOL, SEARCH_DOCS_TOOL] : []),
    ...(deps.guidance?.hasResources?.(agent.id) ? [USE_RESOURCE_TOOL, SEARCH_RESOURCES_TOOL] : []),
  ]
  const allowed = [...agent.allowedTools, ...automatic.filter((tool) => !agent.allowedTools.includes(tool))]
  const local = deps.localFor(allowed)
  if (local.length) sections.push(toolSection('local', 'Ferramentas locais', local))

  for (const [server, choice] of mcpSelection(allowed)) {
    const tools = await deps.mcpTools(server)
    if (!tools) {
      sections.push({ key: `mcp:${server}`, label: `MCP ${server}`, tokens: null, note: 'fora do ar: não medido' })
      continue
    }
    const chosen = tools.filter((tool) => choice.all || choice.tools.has(tool.name))
    sections.push(toolSection(`mcp:${server}`, `MCP ${server}`, chosen))
  }

  const natives = allowed.filter((tool) => tool.startsWith('sdk:'))
  if (natives.length) {
    sections.push({
      key: 'sdk',
      label: 'Ferramentas do SDK',
      tokens: null,
      items: natives.map((name) => ({ name, tokens: 0 })),
      note: 'o SDK do provider manda a definição delas; daqui não dá para medir',
    })
  }

  return {
    total: sections.reduce((sum, section) => sum + (section.tokens ?? 0), 0),
    ...(projectId ? { project: projectId } : {}),
    sections,
    ...(cli ? { cli } : {}),
  }
}

/**
 * O prompt como o `composeSystemPrompt` o monta (o soul com a instrução, depois o ambiente, as seções separadas por
 * linha em branco), medido como argumento de cada CLI do agente — o maior vale.
 */
function cliFootprint(
  cli: { providers: string[]; protocols: EProvider[] },
  texts: ReadonlyArray<{ key: string; label: string; text: string }>,
  extra: Array<string | undefined>,
): ICliFootprint {
  const identity = texts
    .filter((part) => part.key === 'soul' || part.key === 'instructions')
    .map((part) => part.text)
    .join('')
  const environment = [...texts.filter((part) => part.key !== 'soul' && part.key !== 'instructions').map((part) => part.text), ...extra.filter((text): text is string => !!text)]
  const prompt = [identity, ...environment].join('\n\n')
  return {
    providers: cli.providers,
    bytes: Math.max(...cli.protocols.map((protocol) => cliArgumentBytes(protocol, prompt))),
    limit: CLI_ARG_MAX_BYTES,
    warnAt: Math.floor(CLI_ARG_MAX_BYTES * CLI_ARG_WARN_RATIO),
    parts: texts.map((part) => ({ key: part.key, label: part.label, bytes: Buffer.byteLength(part.text) })),
  }
}

function toolSection(key: string, label: string, tools: readonly TToolShape[]): IFootprintSection {
  const items = tools.map((tool) => ({ name: tool.name, tokens: toolTokens(tool) })).sort((a, b) => b.tokens - a.tokens)
  return { key, label, tokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
}
