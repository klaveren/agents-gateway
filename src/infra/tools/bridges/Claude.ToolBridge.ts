import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgentMcpServer } from '../Tool.Catalog'
import { ILocalTool } from '../Tool.Types'

/**
 * O servidor in-process das ferramentas LOCAIS (as tools viram `mcp__local__<tool>`). ⚠️ Não `gateway`: com o MCP do
 * próprio gateway montado ao lado (`mcp_gateway`), os nomes quase iguais faziam o modelo chamar
 * `mcp__mcp_gateway__read_doc` — uma ferramenta que não existe.
 */
export const LOCAL_SERVER_NAME = 'local'

/**
 * O Claude Agent SDK quer tools como um MCP server. Para as locais ele oferece um
 * servidor in-process (`createSdkMcpServer`), o que evita subir qualquer processo extra.
 */
/** O nome do servidor MCP no SDK (as tools viram `mcp__<nome>__<tool>`): `mcp_<id>`, sem hífen. */
export function claudeMcpServerName(serverId: string): string {
  return `mcp_${serverId.replace(/-/g, '_')}`
}

export function buildClaudeMcpServers(local: ILocalTool[], remotes: readonly IAgentMcpServer[] = [], token?: string, context?: IExecutionContext): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  if (local.length > 0) {
    servers[LOCAL_SERVER_NAME] = createSdkMcpServer({
      name: LOCAL_SERVER_NAME,
      version: '1.0.0',
      tools: local.map((item) =>
        tool(item.name, item.description, toZodShape(item), async (args: Record<string, unknown>) => {
          const outcome = await item.execute(args, context)
          return { content: [{ type: 'text' as const, text: outcome.result }], isError: outcome.status === 'error' }
        }),
      ),
    })
  }

  for (const remote of remotes) {
    /**
     * A credencial vai NO HEADER do servidor, conforme o `auth` dele.
     *
     * ⚠️ Este SDK conecta ao MCP por conta própria — não passa pelo `McpServerClient` do gateway, e
     * portanto não herda o `fetch` que injeta a credencial lá. Sem isto, com `auth: caller`, o agente do
     * Claude falaria com o MCP sem token: toda tool responderia "chamada sem credencial".
     */
    const headers = mcpHeaders(remote, token)
    servers[claudeMcpServerName(remote.config.id)] = {
      type: remote.config.transport === 'sse' ? 'sse' : 'http',
      url: remote.config.url,
      ...(headers ? { headers } : {}),
    }
  }

  return servers
}

/**
 * As ferramentas MCP que o modelo NÃO deve ver (`disallowedTools` do SDK), no nome que o SDK dá: as do servidor que
 * ficaram fora da escolha do agente (`IAgentMcpServer.hidden`).
 */
export function claudeHiddenTools(remotes: readonly IAgentMcpServer[]): string[] {
  return remotes.flatMap((remote) => (remote.hidden ?? []).map((name) => `mcp__${claudeMcpServerName(remote.config.id)}__${name}`))
}

/** Os headers de um servidor MCP para quem conecta por conta própria (os SDKs agênticos). */
export function mcpHeaders(remote: IAgentMcpServer, token?: string): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...remote.fixed }
  if (remote.config.auth === 'caller' && token) headers[remote.callerHeader ?? 'authorization'] = `Bearer ${token}`
  if (remote.config.auth === 'header' && remote.header) headers[remote.header.name] = remote.header.value
  return Object.keys(headers).length ? headers : undefined
}

/** O helper `tool()` do SDK só aceita raw shape do zod, não JSON Schema. */
function toZodShape(item: ILocalTool): ZodRawShape {
  const entries = Object.entries(item.inputSchema.properties).map(([key, property]) => {
    // Lido com cuidado porque `properties` é JSON Schema aberto: uma tool pode declarar propriedade
    // sem `description`, ou com `type` composto. Cair para string é o que o SDK já fazia na prática.
    const type = typeof property.type === 'string' ? property.type : 'string'
    const description = typeof property.description === 'string' ? property.description : ''

    // Lista: de texto (o que as nossas declaram — `docIds`); antes virava texto, e o modelo mandava a lista como string.
    // Objeto: livre (o registro do agente no rascunho); a validação é da própria ferramenta.
    const base =
      type === 'number'
        ? z.number()
        : type === 'boolean'
          ? z.boolean()
          : type === 'array'
            ? z.array(z.string())
            : type === 'object'
              ? z.record(z.string(), z.unknown())
              : z.string()
    const described = description ? base.describe(description) : base
    return [key, item.inputSchema.required.includes(key) ? described : described.optional()] as const
  })

  return Object.fromEntries(entries) as ZodRawShape
}
