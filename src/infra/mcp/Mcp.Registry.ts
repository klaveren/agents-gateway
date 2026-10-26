import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { IMcpServerConfig, mcpEnvSecretKey, mcpSecretKey } from '@domain/models/McpServer.Model'
import { containerArgs, instanceName, openEgress } from '@infra/sandbox/Docker.Sandbox'
import { resolveAllowedHosts } from '@infra/sandbox/Egress.Proxy'
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
  /** Só em contêiner: quantas instâncias (conversas) estão de pé agora. */
  instances?: number
}

interface IInstance {
  client: McpServerClient
  sessionId: string
  lastUsed: number
  close: () => Promise<void>
}

const MINUTE = 60_000
const maxInstances = () => Number.parseInt(process.env.MCP_CONTAINER_MAX ?? '', 10) || 10
const idleMs = () => (Number.parseInt(process.env.MCP_CONTAINER_IDLE_MINUTES ?? '', 10) || 15) * MINUTE

/** Só o que o `docker` precisa para falar com o daemon — ⛔ nada do ambiente do gateway (chaves, `.env`). */
function dockerEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() }
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY']) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
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

  /**
   * ⛔ CONTÊINER: UMA INSTÂNCIA POR CONVERSA (chave `servidor + sessão`). Navegador, cookies e arquivos de
   * uma conversa nunca são vistos por outra; a instância morre por ociosidade.
   */
  private readonly instances = new Map<string, IInstance>()
  private readonly starting = new Map<string, Promise<IInstance | undefined>>()
  private sessionLookup: (sessionId: string) => { agentId: string; metadata?: Record<string, unknown> } | undefined = () => undefined
  private reaper?: NodeJS.Timeout

  constructor(
    private readonly servers: IMcpServerRepository,
    private readonly secrets: ICredentialSource,
    private readonly make: TMcpClientFactory = (config, options) => new McpServerClient(config.url, {}, options),
    /** Headers fixos por servidor (ninguém usa na composição; fica para o teste e para quem monta à mão). */
    readonly fixedHeaders: (config: IMcpServerConfig) => Record<string, string> | undefined = () => undefined,
  ) {}

  /** De onde vem uma conversa viva (agente e `metadata`, para `{meta:chave}` e o proxy). Ligado na composição. */
  setSessionLookup(lookup: (sessionId: string) => { agentId: string; metadata?: Record<string, unknown> } | undefined): void {
    this.sessionLookup = lookup
  }

  session(sessionId: string): { agentId: string; metadata?: Record<string, unknown> } | undefined {
    return this.sessionLookup(sessionId)
  }

  /** O cliente certo: o compartilhado (remoto) ou a instância DESTA conversa (contêiner). */
  async clientFor(id: string, sessionId?: string): Promise<McpServerClient | undefined> {
    const config = this.servers.get(id)
    if (config?.kind !== 'container') return this.client(id)
    if (!config.enabled || !sessionId) return undefined
    return (await this.instance(config, sessionId))?.client
  }

  private async instance(config: IMcpServerConfig, sessionId: string): Promise<IInstance | undefined> {
    const key = `${config.id}\u0000${sessionId}`
    const current = this.instances.get(key)
    if (current) {
      current.lastUsed = Date.now()
      return current
    }
    const pending = this.starting.get(key)
    if (pending) return pending

    const start = this.startInstance(config, sessionId, key).finally(() => this.starting.delete(key))
    this.starting.set(key, start)
    return start
  }

  private async startInstance(config: IMcpServerConfig, sessionId: string, key: string): Promise<IInstance | undefined> {
    if (this.instances.size + this.starting.size > maxInstances()) throw new Error(`too many isolated MCP instances running (MCP_CONTAINER_MAX=${maxInstances()}); try again later`)
    const container = config.container!
    const instance = instanceName()
    const egress =
      container.network === 'allowlist' ? await openEgress(config.id, instance, resolveAllowedHosts(container.allowedHosts, this.sessionLookup(sessionId)?.metadata)) : undefined

    const env = dockerEnv()
    for (const name of container.env) {
      const value = this.secrets.get(mcpEnvSecretKey(config.id, name))
      if (value) env[name] = value
    }
    const args = containerArgs({
      image: container.image,
      args: container.args,
      writable: container.writable,
      memoryMb: container.memoryMb,
      cpus: container.cpus,
      envNames: container.env,
      network: egress ? { mode: 'allowlist', name: egress.name, proxyUrl: egress.proxyUrl } : { mode: 'none' },
      serverId: config.id,
      instance,
    })
    const client = new McpServerClient(`container://${config.id}`, {}, { auth: 'none', label: config.id, stdio: { command: 'docker', args, env } })
    if (!(await client.connect())) {
      await client.close()
      await egress?.close()
      throw new Error(client.lastError ?? `could not start the ${config.id} container`)
    }

    const entry: IInstance = {
      client,
      sessionId,
      lastUsed: Date.now(),
      close: async () => {
        this.instances.delete(key)
        await client.close()
        await egress?.close()
      },
    }
    this.instances.set(key, entry)
    this.startReaper()
    return entry
  }

  /** Encerra as instâncias ociosas (ou todas, de um servidor). */
  async closeInstances(filter: { serverId?: string; idleOnly?: boolean } = {}): Promise<number> {
    const now = Date.now()
    const victims = [...this.instances.entries()].filter(
      ([key, entry]) => (!filter.serverId || key.startsWith(`${filter.serverId}\u0000`)) && (!filter.idleOnly || now - entry.lastUsed > idleMs()),
    )
    await Promise.all(victims.map(([, entry]) => entry.close()))
    return victims.length
  }

  private startReaper(): void {
    if (this.reaper) return
    this.reaper = setInterval(() => void this.closeInstances({ idleOnly: true }), MINUTE)
    this.reaper.unref()
  }

  list(): IMcpServerConfig[] {
    return this.servers.list()
  }

  get(id: string): IMcpServerConfig | undefined {
    return this.servers.get(id)
  }

  /** O cliente de um servidor LIGADO; `undefined` se não existe ou está desligado. */
  client(id: string): McpServerClient | undefined {
    const config = this.servers.get(id)
    // Contêiner não tem cliente compartilhado: é uma instância por conversa (`clientFor`).
    if (!config?.enabled || config.kind === 'container') {
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
  async connected(id: string, sessionId?: string): Promise<McpServerClient | undefined> {
    const client = await this.clientFor(id, sessionId).catch(() => undefined)
    return client && (await client.ensureConnected()) ? client : undefined
  }

  async tools(id: string, sessionId?: string): Promise<IToolDefinition[]> {
    return (await this.connected(id, sessionId))?.listTools() ?? []
  }

  /** Para a tela: as ferramentas de um contêiner numa instância DESCARTÁVEL (aberta e fechada aqui). */
  async probeTools(id: string): Promise<IToolDefinition[]> {
    const config = this.servers.get(id)
    if (config?.kind !== 'container') return this.tools(id)
    const result = await this.test(id)
    return result.tools
  }

  /** "Testar conexão": tenta AGORA, ignorando o backoff, e lista as ferramentas. */
  async test(id: string): Promise<{ ok: boolean; tools: IToolDefinition[]; message?: string }> {
    const config = this.servers.get(id)
    if (config?.kind === 'container') {
      if (!config.enabled) return { ok: false, tools: [], message: 'server is disabled' }
      const probe = `probe:${instanceName()}`
      try {
        const entry = await this.instance(config, probe)
        const tools = (await entry?.client.listTools()) ?? []
        await entry?.close()
        return { ok: true, tools }
      } catch (error: unknown) {
        return { ok: false, tools: [], message: error instanceof Error ? error.message : String(error) }
      }
    }
    const client = this.client(id)
    if (!client) return { ok: false, tools: [], message: 'server is disabled or does not exist' }
    await client.close()
    if (!(await client.connect())) return { ok: false, tools: [], message: client.lastError ?? 'could not connect' }
    return { ok: true, tools: await client.listTools() }
  }

  /** Conecta os ligados, sem bloquear quem chamou por um servidor fora do ar. */
  async connectAll(): Promise<void> {
    // Contêiner não conecta no boot: a instância nasce na primeira ferramenta de cada conversa.
    await Promise.all(
      this.servers
        .list()
        .filter((config) => config.kind !== 'container')
        .map((config) => this.client(config.id)?.connect()),
    )
  }

  status(): IMcpServerStatus[] {
    return this.servers.list().map((config) => {
      if (config.kind === 'container') {
        const instances = [...this.instances.keys()].filter((key) => key.startsWith(`${config.id}\u0000`)).length
        return { id: config.id, name: config.name, enabled: config.enabled, connected: config.enabled, instances }
      }
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
