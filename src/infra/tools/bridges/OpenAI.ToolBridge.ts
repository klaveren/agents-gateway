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

/**
 * O servidor MCP remoto, com a credencial de quem chamou nos headers.
 *
 * ⚠️ O token vem do PROVIDER, por parâmetro. Este SDK conecta ao MCP por conta própria — não passa
 * pelo `McpServerClient` do gateway — e sem a credencial toda tool responde "chamada sem
 * credencial", com o agente encerrando a conversa dizendo que não conseguiu consultar.
 */
export function buildOpenAIMcpServers(remoteUrl?: string, token?: string): MCPServer[] {
  if (!remoteUrl) return []
  return [
    new MCPServerStreamableHttp({
      url: remoteUrl,
      name: 'gateway-mcp',
      cacheToolsList: true,
      ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
    }),
  ]
}

function toArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}
