import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'
import { IAgentMcpServer } from '../Tool.Catalog'
import { ILocalTool } from '../Tool.Types'

export const LOCAL_SERVER_NAME = 'gateway'

/**
 * O Claude Agent SDK quer tools como um MCP server. Para as locais ele oferece um
 * servidor in-process (`createSdkMcpServer`), o que evita subir qualquer processo extra.
 */
/** O nome do servidor MCP no SDK (as tools viram `mcp__<nome>__<tool>`): `mcp_<id>`, sem hífen. */
export function claudeMcpServerName(serverId: string): string {
  return `mcp_${serverId.replace(/-/g, '_')}`
}

export function buildClaudeMcpServers(local: ILocalTool[], remotes: readonly IAgentMcpServer[] = [], token?: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}

  if (local.length > 0) {
    servers[LOCAL_SERVER_NAME] = createSdkMcpServer({
      name: LOCAL_SERVER_NAME,
      version: '1.0.0',
      tools: local.map((item) =>
        tool(item.name, item.description, toZodShape(item), async (args: Record<string, unknown>) => {
          const outcome = await item.execute(args)
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

/** Os headers de um servidor MCP para quem conecta por conta própria (os SDKs agênticos). */
export function mcpHeaders(remote: IAgentMcpServer, token?: string): Record<string, string> | undefined {
  if (remote.config.auth === 'caller') return token ? { authorization: `Bearer ${token}` } : undefined
  if (remote.config.auth === 'header' && remote.header) return { [remote.header.name]: remote.header.value }
  return undefined
}

/** O helper `tool()` do SDK só aceita raw shape do zod, não JSON Schema. */
function toZodShape(item: ILocalTool): ZodRawShape {
  const entries = Object.entries(item.inputSchema.properties).map(([key, property]) => {
    // Lido com cuidado porque `properties` é JSON Schema aberto: uma tool pode declarar propriedade
    // sem `description`, ou com `type` composto. Cair para string é o que o SDK já fazia na prática.
    const type = typeof property.type === 'string' ? property.type : 'string'
    const description = typeof property.description === 'string' ? property.description : ''

    const base = type === 'number' ? z.number() : type === 'boolean' ? z.boolean() : z.string()
    const described = description ? base.describe(description) : base
    return [key, item.inputSchema.required.includes(key) ? described : described.optional()] as const
  })

  return Object.fromEntries(entries) as ZodRawShape
}
