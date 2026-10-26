import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { IExecutionContext } from '@domain/models/ExecutionContext.Model'
import { TMcpAuth, TMcpTransport } from '@domain/models/McpServer.Model'
import { IToolDefinition, IToolResult, IToolSchema } from '@infra/tools/Tool.Types'
import { CallerTokenScope } from './Caller.TokenScope'

const CLIENT_INFO = { name: 'agents-gateway', version: '1.0.0-alpha' }

export const BASE_RETRY_MS = 1_000
export const MAX_RETRY_MS = 60_000

export interface IMcpClientDeps {
  createClient?: () => Client
  /** Injetável para o teste não precisar dormir esperando o backoff. */
  now?: () => number
  /** O `fetch` de base (o teste injeta um falso para conferir os headers). */
  fetch?: typeof fetch
}

/**
 * Como o cliente fala com ESTE servidor. Padrão: `caller` (a credencial de quem conversa) e `auto`
 * (Streamable HTTP, caindo para SSE) — o comportamento de antes dos servidores virarem cadastro.
 */
export interface IMcpClientOptions {
  auth?: TMcpAuth
  /** O header fixo de `auth: header`, LIDO A CADA REQUISIÇÃO: trocar o segredo vale sem reconectar. */
  header?: () => { name: string; value: string } | undefined
  transport?: TMcpTransport
  /** Em que header vai a credencial de `auth: caller`. Padrão `authorization`. */
  callerHeader?: string
  /** Headers fixos de toda requisição (ex.: `X-Gateway-Session`, no proxy dos MCPs em contêiner). */
  fixedHeaders?: () => Record<string, string> | undefined
  /** O nome no log (o id do servidor). */
  label?: string
  /** Em vez de HTTP: um processo (o `docker run` de um MCP em contêiner) falando MCP pelo stdio. */
  stdio?: { command: string; args: string[]; env: Record<string, string> }
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
  private readonly tokenScope = new CallerTokenScope()
  private connected = false
  private generation = 0
  private failures = 0
  private nextAttemptAt = 0
  private inFlight?: Promise<boolean>
  private readonly createClient: () => Client
  private readonly now: () => number
  private readonly baseFetch: typeof fetch
  /** O último erro de conexão ou de chamada, para a tela de MCPs. */
  lastError?: string

  constructor(
    public readonly serverUrl: string,
    deps: IMcpClientDeps = {},
    private readonly options: IMcpClientOptions = {},
  ) {
    this.createClient = deps.createClient ?? (() => new Client(CLIENT_INFO))
    this.now = deps.now ?? Date.now
    this.baseFetch = deps.fetch ?? fetch
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
      this.lastError = withoutRemoteBody(toMessage(error))
      console.warn(`[mcp] Falha ao listar tools: ${toMessage(error)}`)
      await this.markDisconnected()
      return []
    }
  }

  /** As ferramentas como o servidor as descreve (esquema inteiro) — para o proxy MCP repassar sem perder nada. */
  async listToolsRaw(): Promise<Array<Record<string, unknown>>> {
    if (!(await this.ensureConnected()) || !this.client) return []
    try {
      return (await this.client.listTools()).tools as Array<Record<string, unknown>>
    } catch (error: unknown) {
      this.lastError = withoutRemoteBody(toMessage(error))
      await this.markDisconnected()
      return []
    }
  }

  /** A chamada com a resposta INTEIRA (imagens, recursos) — para o proxy MCP. */
  async callToolRaw(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!(await this.ensureConnected()) || !this.client) return { content: [{ type: 'text', text: `MCP server unavailable; cannot run "${name}".` }], isError: true }
    try {
      return (await this.client.callTool({ name, arguments: args })) as Record<string, unknown>
    } catch (error: unknown) {
      await this.markDisconnected()
      return { content: [{ type: 'text', text: `MCP call failed: ${toMessage(error)}` }], isError: true }
    }
  }

  async callTool(name: string, args: Record<string, unknown>, context?: IExecutionContext): Promise<IToolResult> {
    if (!(await this.ensureConnected()) || !this.client) {
      return { status: 'error', result: `MCP server unavailable; cannot run "${name}".` }
    }

    const client = this.client

    // A credencial vai pelo escopo da chamada, nunca por campo compartilhado (`Caller.TokenScope`).
    return this.tokenScope.run(context?.token, async () => {
      try {
        const response = await client.callTool({ name, arguments: args })
        const text = readText(response.content)

        return response.isError ? { status: 'error', result: text || 'Unknown MCP error' } : { status: 'success', result: text }
      } catch (error: unknown) {
        await this.markDisconnected()
        return { status: 'error', result: `MCP call failed: ${toMessage(error)}` }
      }
    })
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
    const fetchWithCredential = this.credentialFetch()
    const transport = this.options.transport ?? 'auto'
    const stdio = this.options.stdio
    const makers = stdio
      ? [() => new StdioClientTransport({ command: stdio.command, args: stdio.args, env: stdio.env, stderr: 'ignore' })]
      : [
          ...(transport === 'sse' ? [] : [() => new StreamableHTTPClientTransport(url, { fetch: fetchWithCredential })]),
          ...(transport === 'http' ? [] : [() => new SSEClientTransport(url, { fetch: fetchWithCredential })]),
        ]

    for (const makeTransport of makers) {
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

        this.lastError = undefined
        console.log(`[mcp] Conectado em ${this.serverUrl}`)
        return true
      } catch (error: unknown) {
        this.lastError = withoutRemoteBody(toMessage(error))
        // Transporte que falhou continua segurando timer de reconexão e socket. Sem fechar,
        // cada tentativa do backoff vaza um handle — e o backoff tenta para sempre.
        await transport.close().catch(() => undefined)
        continue
      }
    }

    this.scheduleRetry()
    return false
  }

  /**
   * O `fetch` com a credencial DESTE servidor:
   * - `caller`: a de quem chamou, pelo escopo da chamada (ver `CallerTokenScope`);
   * - `header`: o segredo fixo, lido na hora;
   * - `none`: nada.
   */
  private credentialFetch(): typeof fetch {
    const auth = this.options.auth ?? 'caller'
    const fixed = this.options.fixedHeaders
    const base: typeof fetch = fixed
      ? (input, init) => {
          const extra = fixed()
          if (!extra) return this.baseFetch(input, init)
          const headers = new Headers(init?.headers)
          for (const [name, value] of Object.entries(extra)) headers.set(name, value)
          return this.baseFetch(input, { ...init, headers })
        }
      : this.baseFetch
    if (auth === 'caller') return this.tokenScope.wrap(base, this.options.callerHeader)
    if (auth === 'none') return base

    return (input, init) => {
      const header = this.options.header?.()
      if (!header) return base(input, init)
      const headers = new Headers(init?.headers)
      headers.set(header.name, header.value)
      return base(input, { ...init, headers })
    }
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

/**
 * ⛔ O erro do SDK traz o CORPO da resposta remota (`Error POSTing to endpoint: <corpo>`). Com uma URL
 * interna cadastrada, isso virava leitura de qualquer serviço da rede pela tela. Fica só o começo, curto.
 */
export function withoutRemoteBody(message: string): string {
  const cut = message.replace(/(Error [A-Z]+ing to endpoint)[^:]*:[\s\S]*$/, '$1 (remote body omitted)')
  return cut.length > 200 ? `${cut.slice(0, 200)}…` : cut
}
