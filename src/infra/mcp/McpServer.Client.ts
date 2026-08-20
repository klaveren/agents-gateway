import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { IToolDefinition, IToolResult, IToolSchema } from '@infra/tools/Tool.Types'

const CLIENT_INFO = { name: 'agents-gateway', version: '1.0.0-alpha' }

export const BASE_RETRY_MS = 1_000
export const MAX_RETRY_MS = 60_000

export interface IMcpClientDeps {
  createClient?: () => Client
  /** Injetável para o teste não precisar dormir esperando o backoff. */
  now?: () => number
}

/**
 * Cliente MCP de verdade, sobre o `@modelcontextprotocol/sdk`.
 *
 * Três regras de convivência: nenhuma tentativa de conexão lança — o gateway segue com o
 * toolset local; a descoberta devolve lista vazia em vez de derrubar a sessão; e a conexão
 * se recupera sozinha, com backoff, porque o MCP server pode subir depois do gateway ou
 * cair no meio do expediente.
 */
export class McpServerClient {
  private client?: Client
  private connected = false
  private generation = 0
  private failures = 0
  private nextAttemptAt = 0
  private inFlight?: Promise<boolean>
  private readonly createClient: () => Client
  private readonly now: () => number

  constructor(
    public readonly serverUrl: string,
    deps: IMcpClientDeps = {},
  ) {
    this.createClient = deps.createClient ?? (() => new Client(CLIENT_INFO))
    this.now = deps.now ?? Date.now
  }

  isConnected(): boolean {
    return this.connected
  }

  /**
   * Muda a cada conexão bem-sucedida.
   *
   * Quem guarda recurso derivado da conexão — o adapter do GPT cacheia os MCP servers do
   * SDK — compara a geração para saber que precisa reconstruir.
   */
  get connectionGeneration(): number {
    return this.generation
  }

  /** Tenta agora, ignorando o backoff. É o que o boot chama. */
  async connect(): Promise<boolean> {
    if (this.connected) return true
    return this.attempt()
  }

  /**
   * Tenta apenas quando a janela de backoff já passou.
   *
   * É o que as chamadas normais usam: sem isto, com o server fora do ar, toda requisição
   * pagaria o custo de um handshake que vai falhar.
   */
  async ensureConnected(): Promise<boolean> {
    if (this.connected) return true
    if (this.inFlight) return this.inFlight
    if (this.now() < this.nextAttemptAt) return false
    return this.attempt()
  }

  async listTools(): Promise<IToolDefinition[]> {
    if (!(await this.ensureConnected()) || !this.client) return []

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
      await this.markDisconnected()
      return []
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<IToolResult> {
    if (!(await this.ensureConnected()) || !this.client) {
      return { status: 'error', result: `MCP server unavailable; cannot run "${name}".` }
    }

    try {
      const response = await this.client.callTool({ name, arguments: args })
      const text = readText(response.content)

      return response.isError ? { status: 'error', result: text || 'Unknown MCP error' } : { status: 'success', result: text }
    } catch (error: unknown) {
      await this.markDisconnected()
      return { status: 'error', result: `MCP call failed: ${toMessage(error)}` }
    }
  }

  async close(): Promise<void> {
    this.connected = false
    this.nextAttemptAt = 0
    this.failures = 0
    await this.disposeClient()
  }

  /** Uma tentativa por vez: chamadas concorrentes compartilham o mesmo handshake. */
  private attempt(): Promise<boolean> {
    this.inFlight ??= this.handshake().finally(() => {
      this.inFlight = undefined
    })

    return this.inFlight
  }

  /**
   * Tenta o StreamableHTTP, que é o transporte atual, e cai para SSE, que muitos servers
   * ainda expõem.
   */
  private async handshake(): Promise<boolean> {
    const url = new URL(this.serverUrl)

    for (const makeTransport of [() => new StreamableHTTPClientTransport(url), () => new SSEClientTransport(url)]) {
      try {
        const client = this.createClient()
        await client.connect(makeTransport())

        await this.disposeClient()
        this.client = client
        this.connected = true
        this.failures = 0
        this.nextAttemptAt = 0
        this.generation += 1

        console.log(`[mcp] Conectado em ${this.serverUrl}`)
        return true
      } catch {
        continue
      }
    }

    this.scheduleRetry()
    return false
  }

  private async markDisconnected(): Promise<void> {
    this.connected = false
    await this.disposeClient()
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    this.failures += 1
    const delay = Math.min(BASE_RETRY_MS * 2 ** (this.failures - 1), MAX_RETRY_MS)
    this.nextAttemptAt = this.now() + delay

    console.warn(`[mcp] Sem MCP em ${this.serverUrl}; seguindo com as tools locais. Nova tentativa em ${Math.round(delay / 1000)}s.`)
  }

  private async disposeClient(): Promise<void> {
    const stale = this.client
    this.client = undefined
    if (stale) await stale.close().catch(() => undefined)
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
