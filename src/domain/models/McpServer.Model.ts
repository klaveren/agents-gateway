import { isCloudMetadataHost } from '../Url.Policy'
import { PROJECT_ID_PATTERN } from './Project.Model'
/**
 * Um servidor MCP cadastrado pela tela, de onde os agentes tiram ferramentas.
 *
 * ⚖️ A CREDENCIAL É POR SERVIDOR (`auth`):
 * - `caller` repassa a credencial de QUEM CONVERSA (o MCP decide o que cada pessoa vê) — o de sempre;
 * - `header` manda um valor fixo, secreto, guardado cifrado (uma chave de API do serviço);
 * - `none`, nada.
 */
export type TMcpAuth = 'caller' | 'header' | 'none'
export type TMcpTransport = 'auto' | 'http' | 'sse'

/**
 * `remote`: um MCP que já está no ar, por HTTP/SSE. `container`: o gateway sobe a imagem num contêiner
 * ISOLADO, um por conversa (ver `IMcpContainer`). `process`: um processo do PRÓPRIO gateway (pacote npm ou
 * comando), sem isolamento — ver `IMcpProcess`.
 */
export type TMcpKind = 'remote' | 'container' | 'process'

/**
 * Um MCP em contêiner. ⛔ O que NÃO está aqui não é configurável: disco só leitura, sem capacidades, sem
 * volumes, sem portas, sem a rede do servidor — as travas são do gateway, não do cadastro.
 */
export interface IMcpContainer {
  image: string
  args: string[]
  /** Caminhos graváveis (em memória) — o resto é só leitura. */
  writable: string[]
  memoryMb: number
  cpus: number
  /** `none`: sem rede. `allowlist`: só os domínios listados, pelo proxy do gateway. */
  network: 'none' | 'allowlist'
  /** Domínios (com subdomínios) ou `{meta:chave}` — o valor daquela chave no `metadata` da conversa. */
  allowedHosts: string[]
  /** Nomes das variáveis secretas (os valores ficam cifrados no cofre, `mcp:<id>:env:<NOME>`). */
  env: string[]
}

export const MCP_CONTAINER_DEFAULTS: Pick<IMcpContainer, 'writable' | 'memoryMb' | 'cpus' | 'network' | 'allowedHosts' | 'env' | 'args'> = {
  args: [],
  writable: [],
  memoryMb: 1024,
  cpus: 1,
  network: 'none',
  allowedHosts: [],
  env: [],
}

/**
 * Um MCP que roda como processo do gateway, falando MCP pelo stdio.
 *
 * ⚖️ SEM TRAVA, DE PROPÓSITO: o processo tem o usuário, o disco e a rede do gateway. É escolha de quem
 * administra (o Playwright precisa de navegador e rede de verdade); o isolamento, quando importa, é o
 * `container`. ⛔ O ambiente não herda o `.env` do gateway: só o básico e as variáveis declaradas.
 */
export interface IMcpProcess {
  /** Spec npm (`@playwright/mcp@0.0.41`), instalado em `<dados>/mcp/<id>` pelo botão Instalar. */
  package?: string
  /** Com pacote: o nome do bin, quando ele tem vários. Sem pacote: o comando, no PATH (`npx`, `uvx`, caminho absoluto). */
  command?: string
  args: string[]
  /** Nomes das variáveis secretas (os valores ficam cifrados no cofre, `mcp:<id>:env:<NOME>`). */
  env: string[]
  /** `conversation`: um processo por conversa (navegador, cookies e arquivos separados). `shared`: um só para todas. */
  scope: 'conversation' | 'shared'
}

export const MCP_PROCESS_DEFAULTS: Pick<IMcpProcess, 'args' | 'env' | 'scope'> = { args: [], env: [], scope: 'conversation' }

/** As variáveis secretas declaradas, do contêiner ou do processo. */
export const mcpEnvNames = (server: Pick<IMcpServerConfig, 'container' | 'process'>): string[] => server.container?.env ?? server.process?.env ?? []

/** Contêiner e processo não têm cliente compartilhado: sobem instâncias (por conversa, ou uma só em `shared`). */
export const isLaunchedMcp = (server: Pick<IMcpServerConfig, 'kind'> | undefined): boolean => server?.kind === 'container' || server?.kind === 'process'

/** ⛔ `serverKey` é a CHAVE do servidor (`mcpServerKey`), nunca o id solto: dois projetos com o mesmo id não dividem segredo. */
export const mcpEnvSecretKey = (serverKey: string, name: string) => `mcp:${serverKey}:env:${name}`

export interface IMcpServerConfig {
  /** O id que o agente cita (`mcp:<id>/…`). Único no escopo visível a um agente, não no gateway (ver `mcpServerKey`). */
  id: string
  /**
   * O projeto dono do servidor (e das credenciais dele). Ausente = GLOBAL: serve a todo agente.
   * ⛔ De projeto, serve só a agente do MESMO projeto — nunca a global, nunca a de outro (ver `mcpServesProject`).
   */
  projectId?: string
  name: string
  /** Padrão `remote`. */
  kind?: TMcpKind
  /** Só em `container`. */
  container?: IMcpContainer
  /** Só em `process`. */
  process?: IMcpProcess
  /** Em `remote`, a URL do MCP. Em `container` e `process`, vazia. */
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  /** O header do segredo quando `auth: header`. Padrão `Authorization`. */
  headerName?: string
  /** Envia a identidade de quem chama (agente, conversa, projeto) em cabeçalhos (ver `Agent.Identity`). Ausente = não. */
  identity?: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

/**
 * ⚖️ A CHAVE DE ARMAZENAMENTO: global é o próprio id (`n8n`, como sempre foi — banco antigo não migra); de projeto,
 * `<projeto>.<id>` (`cliente-a.n8n`). O ponto não cabe em id de servidor nem de projeto, então a chave é única e
 * reversível, e um id solto (o de `mcp:<id>/…`) nunca acerta a chave de um servidor de projeto por engano. É ela que
 * separa tudo o que é por servidor: a linha do banco, o segredo no cofre, a pasta do pacote, o cliente e as instâncias.
 */
export const MCP_SCOPE_SEPARATOR = '.'

export const mcpServerKey = (server: Pick<IMcpServerConfig, 'id' | 'projectId'>): string => (server.projectId ? `${server.projectId}${MCP_SCOPE_SEPARATOR}${server.id}` : server.id)

/** `undefined` = não é uma chave válida. */
export function parseMcpServerKey(key: string): { id: string; projectId?: string } | undefined {
  const parts = key.split(MCP_SCOPE_SEPARATOR)
  if (parts.length === 1) return MCP_SERVER_ID_PATTERN.test(key) ? { id: key } : undefined
  if (parts.length !== 2 || !MCP_SERVER_ID_PATTERN.test(parts[1]) || !PROJECT_ID_PATTERN.test(parts[0])) return undefined
  return { id: parts[1], projectId: parts[0] }
}

/**
 * ⛔ O servidor serve a um agente deste projeto (`undefined` = agente global)? Global serve a todos; de projeto, só ao
 * agente do MESMO projeto. É a regra do cadastro do agente, do turno (todas as lanes) e do proxy.
 */
export const mcpServesProject = (server: Pick<IMcpServerConfig, 'projectId'>, projectId: string | undefined): boolean => !server.projectId || server.projectId === projectId
export const MCP_TOOL_PREFIX = 'mcp:'
/** `mcp:<servidor>/*` = todas as ferramentas do servidor. */
export const MCP_ALL_TOOLS = '*'

/** A chave do segredo do servidor no cofre de credenciais (o mesmo das chaves dos providers). `serverKey`: ver `mcpServerKey`. */
export const mcpSecretKey = (serverKey: string) => `mcp:${serverKey}`

/** Uma escolha de ferramenta MCP num agente: `mcp:<servidor>/<ferramenta>` ou `mcp:<servidor>/*`. */
export interface IMcpToolRef {
  server: string
  tool: string
}

export function isMcpToolRef(entry: string): boolean {
  return entry.startsWith(MCP_TOOL_PREFIX)
}

/** `undefined` = não é uma referência MCP válida. */
export function parseMcpToolRef(entry: string): IMcpToolRef | undefined {
  if (!isMcpToolRef(entry)) return undefined
  const body = entry.slice(MCP_TOOL_PREFIX.length)
  const slash = body.indexOf('/')
  if (slash <= 0) return undefined
  const server = body.slice(0, slash)
  const tool = body.slice(slash + 1)
  if (!MCP_SERVER_ID_PATTERN.test(server) || !tool || tool.length > 128 || /\s/.test(tool)) return undefined
  return { server, tool }
}

export const mcpToolRef = (server: string, tool: string) => `${MCP_TOOL_PREFIX}${server}/${tool}`

/**
 * O que um agente escolheu de cada servidor: `all` (o `/*`) ou a lista. Só os servidores citados entram.
 */
export function mcpSelection(allowedTools: readonly string[]): Map<string, { all: boolean; tools: Set<string> }> {
  const selection = new Map<string, { all: boolean; tools: Set<string> }>()
  for (const entry of allowedTools) {
    const ref = parseMcpToolRef(entry)
    if (!ref) continue
    const current = selection.get(ref.server) ?? selection.set(ref.server, { all: false, tools: new Set() }).get(ref.server)!
    if (ref.tool === MCP_ALL_TOOLS) current.all = true
    else current.tools.add(ref.tool)
  }
  return selection
}

/** A URL do MCP: só http(s), sem credencial embutida (ela vai no `auth`). */
export function mcpUrlIssue(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'not a valid URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'use http:// or https://'
  if (parsed.username || parsed.password) return 'put the credential in the authentication, not in the URL'
  if (isCloudMetadataHost(parsed.hostname)) return 'cloud metadata and link-local addresses are not allowed'
  return undefined
}
