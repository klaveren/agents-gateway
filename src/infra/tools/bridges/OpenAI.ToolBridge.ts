import { MCPServerSSE, MCPServerStreamableHttp, tool, type MCPServer, type Tool } from '@openai/agents'
import { IAgentMcpServer } from '../Tool.Catalog'
import { mcpHeaders } from './Claude.ToolBridge'
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
 * Os servidores MCP do agente, cada um com a SUA credencial e o filtro das ferramentas escolhidas.
 *
 * ⚠️ O token de `auth: caller` vem do PROVIDER, por parâmetro. Este SDK conecta ao MCP por conta própria —
 * não passa pelo `McpServerClient` do gateway — e sem a credencial toda tool responde "chamada sem
 * credencial", com o agente encerrando a conversa dizendo que não conseguiu consultar.
 */
export function buildOpenAIMcpServers(remotes: readonly IAgentMcpServer[] = [], token?: string): MCPServer[] {
  return remotes.map((remote) => {
    const headers = mcpHeaders(remote, token)
    const options = {
      url: remote.config.url,
      name: `mcp_${remote.config.id}`,
      cacheToolsList: true,
      // `undefined` = todas (`mcp:<id>/*`); senão, só as escolhidas no agente.
      ...(remote.tools ? { toolFilter: { allowedToolNames: remote.tools } } : {}),
      ...(headers ? { requestInit: { headers } } : {}),
    }
    return remote.config.transport === 'sse' ? new MCPServerSSE(options) : new MCPServerStreamableHttp(options)
  })
}

function toArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
}
