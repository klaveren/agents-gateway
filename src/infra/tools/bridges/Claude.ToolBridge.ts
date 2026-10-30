import { identityHeaders } from '@domain/Agent.Identity'
import { createSdkMcpServer, tool, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodRawShape, type ZodTypeAny } from 'zod'
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
    const headers = mcpHeaders(remote, token, context)
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
export function mcpHeaders(remote: IAgentMcpServer, token?: string, context?: IExecutionContext): Record<string, string> | undefined {
  // A identidade de quem chama, só no servidor que a pediu (ver `Agent.Identity`).
  const headers: Record<string, string> = { ...remote.fixed, ...(remote.config.identity ? identityHeaders(context) : {}) }
  if (remote.config.auth === 'caller' && token) headers[remote.callerHeader ?? 'authorization'] = `Bearer ${token}`
  if (remote.config.auth === 'header' && remote.header) headers[remote.header.name] = remote.header.value
  return Object.keys(headers).length ? headers : undefined
}

/** O helper `tool()` do SDK só aceita raw shape do zod, não JSON Schema. */
export function toZodShape(item: ILocalTool): ZodRawShape {
  return Object.fromEntries(
    Object.entries(item.inputSchema.properties).map(([key, property]) => {
      const zod = toZod(property)
      return [key, item.inputSchema.required.includes(key) ? zod : zod.optional()] as const
    }),
  ) as ZodRawShape
}

/**
 * Uma propriedade de JSON Schema em zod, com cuidado porque `properties` é JSON Schema aberto: uma tool pode declarar
 * propriedade sem `description`, ou com `type` composto — cair para texto é o que o SDK já fazia na prática.
 * Lista: dos itens que ela declara (texto, ou objeto como as tarefas do `update_todos`). Objeto sem `properties`: livre
 * (o registro do agente no rascunho; quem valida é a própria ferramenta). Texto com `enum`: só esses valores.
 */
function toZod(property: Record<string, unknown>): ZodTypeAny {
  const type = typeof property.type === 'string' ? property.type : 'string'
  const description = typeof property.description === 'string' ? property.description : ''
  const items = property.items && typeof property.items === 'object' ? (property.items as Record<string, unknown>) : undefined
  const properties = property.properties && typeof property.properties === 'object' ? (property.properties as Record<string, Record<string, unknown>>) : undefined
  const required = Array.isArray(property.required) ? (property.required as string[]) : []
  const values = Array.isArray(property.enum) ? (property.enum as unknown[]).filter((value): value is string => typeof value === 'string') : []
  const base: ZodTypeAny =
    type === 'number' || type === 'integer'
      ? z.number()
      : type === 'boolean'
        ? z.boolean()
        : type === 'array'
          ? z.array(items ? toZod(items) : z.string())
          : type === 'object'
            ? properties
              ? z.object(Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, required.includes(key) ? toZod(child) : toZod(child).optional()])))
              : z.record(z.string(), z.unknown())
            : values.length
              ? z.enum(values as [string, ...string[]])
              : z.string()
  return description ? base.describe(description) : base
}
