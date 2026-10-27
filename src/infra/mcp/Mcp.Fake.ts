import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMcpServerConfig, TMcpAuth } from '@domain/models/McpServer.Model'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { IToolDefinition, IToolResult } from '@infra/tools/Tool.Types'
import { McpRegistry } from './Mcp.Registry'
import { McpServerClient } from './McpServer.Client'

export interface IFakeMcpServer {
  id?: string
  /** Função = o estado muda durante o teste (o servidor sobe). */
  connected?: boolean | (() => boolean)
  /** Servidor `caller` que só aceita a conexão com esta credencial (como o MCP do próprio gateway). */
  acceptsToken?: string
  auth?: TMcpAuth
  tools?: IToolDefinition[]
  secret?: string
  onCall?: (name: string, args: Record<string, unknown>, context?: IExecutionContext) => IToolResult | Promise<IToolResult>
}

/**
 * Um `McpRegistry` de verdade sobre servidores FALSOS (cadastro em memória, clientes de mentira) — para
 * os testes dos adapters e do catálogo não precisarem de um MCP no ar.
 */
export function fakeMcpRegistry(servers: IFakeMcpServer[] = []): McpRegistry {
  const repository = new SqliteMcpServerRepository(':memory:')
  const byId = new Map<string, IFakeMcpServer>()
  const now = new Date()
  for (const server of servers) {
    const id = server.id ?? 'crm'
    byId.set(id, server)
    const config: IMcpServerConfig = {
      id,
      name: id.toUpperCase(),
      url: `http://localhost:8000/${id}/mcp`,
      transport: 'auto',
      auth: server.auth ?? 'caller',
      headerName: server.auth === 'header' ? 'X-Api-Key' : undefined,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
    repository.insert(config)
  }

  const secrets = { get: (key: string) => byId.get(key.replace(/^mcp:/, ''))?.secret }
  return new McpRegistry(repository, secrets, (config) => {
    const fake = byId.get(config.id) ?? {}
    const connected = () => (typeof fake.connected === 'function' ? fake.connected() : (fake.connected ?? true))
    return {
      serverUrl: config.url,
      isConnected: connected,
      connect: async () => connected(),
      ensureConnected: async () => connected(),
      ensureConnectedAs: async (token?: string) => connected() || (!!token && token === fake.acceptsToken),
      close: async () => undefined,
      listTools: async () => (connected() ? (fake.tools ?? []) : []),
      callTool: async (name: string, args: Record<string, unknown>, context?: IExecutionContext) =>
        fake.onCall?.(name, args, context) ?? { status: 'success' as const, result: `${config.id}:${name}` },
    } as unknown as McpServerClient
  })
}

export const mcpTool = (name: string, description = ''): IToolDefinition => ({
  name,
  description,
  origin: 'mcp',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
})
