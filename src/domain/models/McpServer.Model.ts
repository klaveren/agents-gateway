import { isCloudMetadataHost } from '../Url.Policy'
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
 * ISOLADO, um por conversa (ver `IMcpContainer`).
 */
export type TMcpKind = 'remote' | 'container'

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

export const mcpEnvSecretKey = (serverId: string, name: string) => `mcp:${serverId}:env:${name}`

export interface IMcpServerConfig {
  id: string
  name: string
  /** Padrão `remote`. */
  kind?: TMcpKind
  /** Só em `container`. */
  container?: IMcpContainer
  /** Em `remote`, a URL do MCP. Em `container`, vazia. */
  url: string
  transport: TMcpTransport
  auth: TMcpAuth
  /** O header do segredo quando `auth: header`. Padrão `Authorization`. */
  headerName?: string
  enabled: boolean
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/
export const MCP_TOOL_PREFIX = 'mcp:'
/** `mcp:<servidor>/*` = todas as ferramentas do servidor. */
export const MCP_ALL_TOOLS = '*'

/** A chave do segredo do servidor no cofre de credenciais (o mesmo das chaves dos providers). */
export const mcpSecretKey = (serverId: string) => `mcp:${serverId}`

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
