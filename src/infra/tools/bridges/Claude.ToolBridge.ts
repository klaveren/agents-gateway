import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape } from 'zod'
import { ILocalTool } from '../Tool.Types'

export const LOCAL_SERVER_NAME = 'gateway'
export const REMOTE_SERVER_NAME = 'mcp'

/**
 * O Claude Agent SDK quer tools como um MCP server. Para as locais ele oferece um
 * servidor in-process (`createSdkMcpServer`), o que evita subir qualquer processo extra.
 */
export function buildClaudeMcpServers(local: ILocalTool[], remoteUrl?: string): Record<string, McpServerConfig> {
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

  if (remoteUrl) {
    servers[REMOTE_SERVER_NAME] = { type: 'http', url: remoteUrl }
  }

  return servers
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
