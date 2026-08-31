import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
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

  /** A credencial da chamada em curso. Ver `callTool` — vive entre a chamada e o `finally`. */
  private pendingToken?: string
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

  async callTool(name: string, args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult> {
    if (!(await this.ensureConnected()) || !this.client) {
      return { status: 'error', result: `MCP server unavailable; cannot run "${name}".` }
    }

    /**
     * A credencial desta chamada, para o `fetch` do transporte encontrar.
     *
     * ⚠️ O SDK não deixa passar header por chamada — os headers são do transporte, criado na
     * conexão. Guardar a credencial aqui e lê-la no `fetch` é o que permite um transporte só
     * servir usuários diferentes.
     *
     * ⛔ E é por isso que ela é LIMPA no `finally`: sem isso, uma chamada sem credencial herdaria
     * a do usuário anterior — que é o vazamento exato que este desenho existe para impedir.
     */
    this.pendingToken = context?.token

    try {
      const response = await this.client.callTool({ name, arguments: args })
      const text = readText(response.content)

      return response.isError ? { status: 'error', result: text || 'Unknown MCP error' } : { status: 'success', result: text }
    } catch (error: unknown) {
      await this.markDisconnected()
      return { status: 'error', result: `MCP call failed: ${toMessage(error)}` }
    } finally {
      this.pendingToken = undefined
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

    /**
     * `fetch` próprio para carregar a credencial DE QUEM CHAMOU em cada requisição.
     *
     * ⚖️ POR QUE AQUI, e não nos headers do transporte. O transporte é criado uma vez, na conexão,
     * e seus headers valem para sempre — o que daria uma credencial só para todos os usuários,
     * exatamente o que este desenho existe para eliminar. Um cliente MCP por pessoa seria a outra
     * saída, ao custo de uma conexão por pessoa.
     *
     * ⚠️ Sem credencial no escopo, a requisição vai SEM header: o MCP então cai no que estiver
     * configurado no ambiente dele. É isso que mantém o `curl` de diagnóstico funcionando.
     */
    const fetchWithCallerToken: typeof fetch = (input, init) => {
      const token = this.pendingToken
      if (!token) return fetch(input, init)

      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${token}`)

      return fetch(input, { ...init, headers })
    }

    for (const makeTransport of [
      () => new StreamableHTTPClientTransport(url, { fetch: fetchWithCallerToken }),
      () => new SSEClientTransport(url, { fetch: fetchWithCallerToken }),
    ]) {
      const transport = makeTransport()

      try {
        const client = this.createClient()
        await client.connect(transport)

        await this.disposeClient()
        this.client = client
        this.connected = true
        this.failures = 0
        this.nextAttemptAt = 0
        this.generation += 1

        console.log(`[mcp] Conectado em ${this.serverUrl}`)
        return true
      } catch {
        // Transporte que falhou continua segurando timer de reconexão e socket. Sem fechar,
        // cada tentativa do backoff vaza um handle — e o backoff tenta para sempre.
        await transport.close().catch(() => undefined)
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
