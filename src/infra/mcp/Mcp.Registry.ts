import { IMcpServerConfig, mcpSecretKey } from '@domain/models/McpServer.Model'
import { ICredentialSource } from '@domain/ports/CredentialStore.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { IToolDefinition } from '@infra/tools/Tool.Types'
import { IMcpClientOptions, McpServerClient } from './McpServer.Client'

export interface IMcpServerStatus {
  id: string
  name: string
  enabled: boolean
  connected: boolean
  lastError?: string
}

export type TMcpClientFactory = (config: IMcpServerConfig, options: IMcpClientOptions) => McpServerClient

/**
 * Os servidores MCP cadastrados, cada um com o SEU cliente (conexão, backoff e credencial próprios).
 *
 * ⚖️ O CADASTRO É LIDO NA HORA: trocar URL, transporte ou credencial pela tela recria o cliente daquele
 * servidor na próxima chamada (a impressão digital da configuração mudou); desligar o some. Sem reiniciar.
 * O segredo de `auth: header` é lido a cada requisição, então trocá-lo nem reconecta.
 */
export class McpRegistry {
  private readonly clients = new Map<string, { fingerprint: string; client: McpServerClient }>()

  constructor(
    private readonly servers: IMcpServerRepository,
    private readonly secrets: ICredentialSource,
    private readonly make: TMcpClientFactory = (config, options) => new McpServerClient(config.url, {}, options),
    /** Headers fixos por servidor (ex.: o portão do próprio gateway). */
    readonly fixedHeaders: (config: IMcpServerConfig) => Record<string, string> | undefined = () => undefined,
  ) {}

  list(): IMcpServerConfig[] {
    return this.servers.list()
  }

  get(id: string): IMcpServerConfig | undefined {
    return this.servers.get(id)
  }

  /** O cliente de um servidor LIGADO; `undefined` se não existe ou está desligado. */
  client(id: string): McpServerClient | undefined {
    const config = this.servers.get(id)
    if (!config?.enabled) {
      this.forget(id)
      return undefined
    }

    const fingerprint = [config.url, config.transport, config.auth, config.headerName ?? ''].join('\u0000')
    const current = this.clients.get(id)
    if (current?.fingerprint === fingerprint) return current.client

    if (current) void current.client.close()
    const client = this.make(config, {
      auth: config.auth,
      transport: config.transport,
      label: config.id,
      callerHeader: config.auth === 'caller' ? config.headerName : undefined,
      header: () => this.header(config.id),
      fixedHeaders: () => this.fixedHeaders(this.servers.get(config.id) ?? config),
    })
    this.clients.set(id, { fingerprint, client })
    return client
  }

  /** O header de `auth: header` agora, ou nada sem segredo salvo. */
  header(id: string): { name: string; value: string } | undefined {
    const config = this.servers.get(id)
    const value = this.secrets.get(mcpSecretKey(id))
    if (config?.auth !== 'header' || !value) return undefined
    return { name: config.headerName || 'Authorization', value }
  }

  /** O cliente, conectado agora (respeitando o backoff), ou `undefined`. */
  async connected(id: string): Promise<McpServerClient | undefined> {
    const client = this.client(id)
    return client && (await client.ensureConnected()) ? client : undefined
  }

  async tools(id: string): Promise<IToolDefinition[]> {
    return (await this.connected(id))?.listTools() ?? []
  }

  /** "Testar conexão": tenta AGORA, ignorando o backoff, e lista as ferramentas. */
  async test(id: string): Promise<{ ok: boolean; tools: IToolDefinition[]; message?: string }> {
    const client = this.client(id)
    if (!client) return { ok: false, tools: [], message: 'server is disabled or does not exist' }
    await client.close()
    if (!(await client.connect())) return { ok: false, tools: [], message: client.lastError ?? 'could not connect' }
    return { ok: true, tools: await client.listTools() }
  }

  /** Conecta os ligados, sem bloquear quem chamou por um servidor fora do ar. */
  async connectAll(): Promise<void> {
    await Promise.all(this.servers.list().map((config) => this.client(config.id)?.connect()))
  }

  status(): IMcpServerStatus[] {
    return this.servers.list().map((config) => {
      const client = config.enabled ? this.client(config.id) : undefined
      return { id: config.id, name: config.name, enabled: config.enabled, connected: client?.isConnected() ?? false, ...(client?.lastError ? { lastError: client.lastError } : {}) }
    })
  }

  forget(id: string): void {
    const current = this.clients.get(id)
    if (!current) return
    this.clients.delete(id)
    void current.client.close()
  }
}
