import { MCPServerSSE, MCPServerStreamableHttp, tool, type MCPServer, type Tool } from '@openai/agents'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IAgentMcpServer } from '../Tool.Catalog'
import { mcpHeaders } from './Claude.ToolBridge'
import { ILocalTool } from '../Tool.Types'

/**
 * O `@openai/agents` aceita JSON Schema direto quando `strict: true`, então as tools
 * locais entram sem precisar de zod. As remotas entram como MCP server nativo.
 *
 * ⚠️ O modo estrito da OpenAI recusa a CHAMADA INTEIRA (400 "additionalProperties is required…") se um objeto do
 * schema for aberto (`{ type: 'object' }` sem `properties`). A ferramenta assim vai sem estrito, e o turno roda.
 */
export function buildOpenAITools(local: ILocalTool[], context?: IExecutionContext): Tool[] {
  return local.map((item) => {
    const build = (strict: boolean) =>
      tool({
        name: item.name,
        description: item.description,
        strict,
        parameters: item.inputSchema as never,
        // A política de segurança vive no executor local, que vale para as três lanes.
        needsApproval: false,
        async execute(args: unknown) {
          const outcome = await item.execute(toArgs(args), context)
          return outcome.result
        },
      })
    if (!strictable(item.inputSchema)) return build(false)
    // ⛔ O SDK recusa no ato o schema que não converte para o estrito ("unsupported keyword `oneOf`…"): antes o turno
    // inteiro caía em "Internal error". A ferramenta vai sem estrito e o turno roda.
    try {
      return build(true)
    } catch (error: unknown) {
      console.warn(`[OpenAI.ToolBridge] ${item.name} vai sem modo estrito: ${error instanceof Error ? error.message : String(error)}`)
      return build(false)
    }
  })
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

const STRICT_UNSUPPORTED = ['oneOf', 'allOf', 'not', 'if', 'then', 'else', 'patternProperties', 'dependentSchemas', 'dependentRequired'] as const

/** O schema fecha no modo estrito? Todo objeto com `properties` (o SDK os fecha) ou já `additionalProperties: false`. */
export function strictable(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(strictable)
  if (typeof schema !== 'object' || schema === null) return true
  const node = schema as Record<string, unknown>
  // O estrito só aceita `anyOf` entre as combinações: `oneOf`, `allOf`, `not` e os condicionais derrubam o turno.
  if (STRICT_UNSUPPORTED.some((keyword) => keyword in node)) return false
  const isObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object'))
  if (isObject && typeof node.properties !== 'object' && node.additionalProperties !== false) return false
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') return false
  const nested = [node.items, node.anyOf, ...Object.values((node.properties as object) ?? {}), ...Object.values((node.$defs as object) ?? {})]
  return nested.every(strictable)
}
