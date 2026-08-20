import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { IToolDefinition, IToolResult, IToolSchema } from '@infra/tools/Tool.Types'

const CLIENT_INFO = { name: 'agents-gateway', version: '1.0.0-alpha' }

export interface IMcpClientDeps {
  createClient?: () => Client
}

/**
 * Cliente MCP de verdade, sobre o `@modelcontextprotocol/sdk`.
 *
 * Duas regras de convivência: `connect()` nunca lança — devolve `false` e o gateway
 * segue com o toolset local; e a descoberta de tools devolve lista vazia quando o
 * server está fora, em vez de derrubar a sessão.
 */
export class McpServerClient {
  private client?: Client
  private connected = false
  private readonly createClient: () => Client

  constructor(
    public readonly serverUrl: string,
    deps: IMcpClientDeps = {},
  ) {
    this.createClient = deps.createClient ?? (() => new Client(CLIENT_INFO))
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * Tenta StreamableHTTP, que é o transporte atual, e cai para SSE, que muitos
   * servers ainda expõem. Devolve `false` em vez de lançar.
   */
  async connect(): Promise<boolean> {
    const url = new URL(this.serverUrl)

    for (const makeTransport of [() => new StreamableHTTPClientTransport(url), () => new SSEClientTransport(url)]) {
      try {
        const client = this.createClient()
        await client.connect(makeTransport())
        this.client = client
        this.connected = true
        console.log(`[mcp] Conectado em ${this.serverUrl}`)
        return true
      } catch {
        continue
      }
    }

    this.connected = false
    console.warn(`[mcp] Nenhum MCP server em ${this.serverUrl}; seguindo só com as tools locais.`)
    return false
  }

  async listTools(): Promise<IToolDefinition[]> {
    if (!this.client || !this.connected) return []

    try {
      const response = await this.client.listTools()
      return response.tools.map((tool) => ({
        origin: 'mcp' as const,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: toSchema(tool.inputSchema),
      }))
    } catch (error: unknown) {
      console.warn(`[mcp] Falha ao listar tools: ${toMessage(error)}`)
      this.connected = false
      return []
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<IToolResult> {
    if (!this.client || !this.connected) {
      return { status: 'error', result: `MCP server unavailable; cannot run "${name}".` }
    }

    try {
      const response = await this.client.callTool({ name, arguments: args })
      const text = readText(response.content)
      return response.isError ? { status: 'error', result: text || 'Unknown MCP error' } : { status: 'success', result: text }
    } catch (error: unknown) {
      return { status: 'error', result: `MCP call failed: ${toMessage(error)}` }
    }
  }

  async close(): Promise<void> {
    this.connected = false
    await this.client?.close().catch(() => undefined)
    this.client = undefined
  }
}

function toSchema(inputSchema: unknown): IToolSchema {
  const schema = (inputSchema ?? {}) as Partial<IToolSchema>
  return {
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    additionalProperties: false,
  }
}

function readText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } => {
      return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
    })
    .map((block) => block.text)
    .join('\n')
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
