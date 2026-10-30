import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { IMcpServerConfig, mcpServerKey, TMcpAuth } from '@domain/models/McpServer.Model'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { IToolDefinition, IToolResult } from '@infra/tools/Tool.Types'
import { McpRegistry } from './Mcp.Registry'
import { McpServerClient } from './McpServer.Client'

export interface IFakeMcpServer {
  id?: string
  /** O projeto dono (ausente = global). */
  projectId?: string
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
  // Pela chave (`mcpServerKey`): o mesmo id em dois projetos são dois servidores.
  const byId = new Map<string, IFakeMcpServer>()
  const now = new Date()
  for (const server of servers) {
    const id = server.id ?? 'crm'
    byId.set(mcpServerKey({ id, projectId: server.projectId }), server)
    const config: IMcpServerConfig = {
      id,
      ...(server.projectId ? { projectId: server.projectId } : {}),
      name: id.toUpperCase(),
      url: `http://localhost:8000/${mcpServerKey({ id, projectId: server.projectId })}/mcp`,
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
    const key = mcpServerKey(config)
    const fake = byId.get(key) ?? {}
    const connected = () => (typeof fake.connected === 'function' ? fake.connected() : (fake.connected ?? true))
    return {
      serverUrl: config.url,
      isConnected: connected,
      connect: async () => connected(),
      ensureConnected: async () => connected(),
      ensureConnectedAs: async (token?: string) => connected() || (!!token && token === fake.acceptsToken),
      close: async () => undefined,
      listTools: async () => (connected() ? (fake.tools ?? []) : []),
      listToolsRaw: async () => (connected() ? (fake.tools ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) : []),
      callToolRaw: async (name: string, args: Record<string, unknown>) => {
        const outcome = (await fake.onCall?.(name, args)) ?? { status: 'success' as const, result: `${key}:${name}` }
        return { content: [{ type: 'text', text: outcome.result }], isError: outcome.status === 'error' }
      },
      listToolsAs: async (token?: string) => (connected() || (!!token && token === fake.acceptsToken) ? (fake.tools ?? []) : []),
      callTool: async (name: string, args: Record<string, unknown>, context?: IExecutionContext) =>
        fake.onCall?.(name, args, context) ?? { status: 'success' as const, result: `${key}:${name}` },
    } as unknown as McpServerClient
  })
}

export const mcpTool = (name: string, description = ''): IToolDefinition => ({
  name,
  description,
  origin: 'mcp',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
})
