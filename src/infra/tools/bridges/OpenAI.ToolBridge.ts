import { MCPServerStreamableHttp, tool, type MCPServer, type Tool } from '@openai/agents'
import { ILocalTool } from '../Tool.Types'

/**
 * O `@openai/agents` aceita JSON Schema direto quando `strict: true`, então as tools
 * locais entram sem precisar de zod. As remotas entram como MCP server nativo.
 */
export function buildOpenAITools(local: ILocalTool[]): Tool[] {
  return local.map((item) =>
    tool({
      name: item.name,
      description: item.description,
      strict: true,
      parameters: item.inputSchema,
      // A política de segurança vive no executor local, que vale para as três lanes.
      needsApproval: false,
      async execute(args: unknown) {
        const outcome = await item.execute(toArgs(args))
        return outcome.result
      },
    }),
  )
}

export function buildOpenAIMcpServers(remoteUrl?: string): MCPServer[] {
  if (!remoteUrl) return []
  return [new MCPServerStreamableHttp({ url: remoteUrl, name: 'gateway-mcp', cacheToolsList: true })]
}

function toArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}
