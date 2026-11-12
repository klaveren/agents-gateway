import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { caller } from './Caller.Identity'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { IMcpServerConfig, isLaunchedMcp, mcpAsksProject, mcpFixedVars, mcpSecretKey, mcpServerKey, mcpServesProject, mcpVarNames } from '@domain/models/McpServer.Model'
import { PROJECT_METADATA_KEY } from '@domain/Session.Metadata'
import { containerArgs, instanceName, openEgress } from '@infra/sandbox/Docker.Sandbox'
import { resolveAllowedHosts } from '@infra/sandbox/Egress.Proxy'
import { ICredentialSource } from '@domain/ports/CredentialStore.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { IToolDefinition } from '@infra/tools/Tool.Types'
import { INSTALL_PASSTHROUGH, isWritable } from '@infra/adapters/support/Subscription.Workspace'
import { installDir, resolveCommand } from './Mcp.Install'
import { IMcpClientOptions, McpServerClient } from './McpServer.Client'

export interface IMcpServerStatus {
  /** A chave (`mcpServerKey`). */
  key: string
  id: string
  projectId?: string
  name: string
  enabled: boolean
  connected: boolean
  lastError?: string
  /** Só em contêiner e processo: quantas instâncias (conversas) estão de pé agora. */
  instances?: number
}

interface IInstance {
  client: McpServerClient
  sessionId: string
  lastUsed: number
  close: () => Promise<void>
}

const MINUTE = 60_000
/** A chave da instância única de um processo `shared`. */
const SHARED = '*'
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
 * ⛔ TUDO AQUI É PELA CHAVE (`mcpServerKey`), nunca pelo id solto: cliente, instâncias, segredo e pacote do `n8n` do
 * projeto A não são os do `n8n` do projeto B. Quem parte de um `mcp:<id>/…` passa por `resolve`, com o projeto do agente.
 *
 * ⚖️ O CADASTRO É LIDO NA HORA: trocar URL, transporte ou credencial pela tela recria o cliente daquele
 * servidor na próxima chamada (a impressão digital da configuração mudou); desligar o some. Sem reiniciar.
 * O segredo de `auth: header` é lido a cada requisição, então trocá-lo nem reconecta.
 */
export class McpRegistry {
  private readonly clients = new Map<string, { fingerprint: string; client: McpServerClient }>()

  /**
   * ⛔ CONTÊINER E PROCESSO: UMA INSTÂNCIA POR CONVERSA (chave `servidor + sessão`). Navegador, cookies e
   * arquivos de uma conversa nunca são vistos por outra; a instância morre por ociosidade. O processo em
   * `shared` é a exceção escolhida no cadastro: uma instância só (`servidor + *`).
   */
  private readonly instances = new Map<string, IInstance>()
  private readonly starting = new Map<string, Promise<IInstance | undefined>>()
  private sessionLookup: (sessionId: string) => { agentId: string; metadata?: Record<string, unknown> } | undefined = () => undefined
  /**
   * ⛔ Os valores que o PROJETO deu às variáveis do servidor (visíveis e secretos), para o ambiente do processo — nunca o
   * terminal do agente. `sessionId`: a conversa cuja máscara aprende os secretos. Ligado na composição; ausente, nenhum.
   */
  private projectEnv: (config: IMcpServerConfig, projectId: string | undefined, sessionId?: string) => Record<string, string> = () => ({})
  /** O token OAuth de cada pessoa (ver `McpOAuth`). Ligado na composição; ausente, `auth: oauth` não tem cliente. */
  private oauth?: { accessToken(serverKey: string, userId: string): Promise<string | undefined> }
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

  useProjectEnv(values: (config: IMcpServerConfig, projectId: string | undefined, sessionId?: string) => Record<string, string>): void {
    this.projectEnv = values
  }

  /** O projeto da conversa viva (o que ela carimbou), ou nenhum. */
  private projectOf(sessionId: string | undefined): string | undefined {
    const project = sessionId ? this.sessionLookup(sessionId)?.metadata?.[PROJECT_METADATA_KEY] : undefined
    return typeof project === 'string' && project ? project : undefined
  }

  useOAuth(oauth: { accessToken(serverKey: string, userId: string): Promise<string | undefined> }): void {
    this.oauth = oauth
  }

  session(sessionId: string): { agentId: string; metadata?: Record<string, unknown> } | undefined {
    return this.sessionLookup(sessionId)
  }

  /**
   * O servidor que um agente deste projeto (`undefined` = global) chama de `id`: o do projeto dele ou o global.
   * ⛔ Nunca o de outro projeto. O cadastro proíbe global e de projeto com o mesmo id; se ainda assim houver os dois,
   * vale o do projeto (nenhum dos dois vaza para fora do escopo).
   */
  resolve(id: string, projectId: string | undefined): IMcpServerConfig | undefined {
    const own = projectId ? this.servers.get(mcpServerKey({ id, projectId })) : undefined
    if (own) return own
    const global = this.servers.get(id)
    return global && mcpServesProject(global, projectId) ? global : undefined
  }

  /** Os servidores que um agente deste projeto enxerga: os globais e os do projeto dele. */
  visibleTo(projectId: string | undefined): IMcpServerConfig[] {
    return this.servers.list().filter((server) => mcpServesProject(server, projectId))
  }

  /** O cliente certo: o compartilhado (remoto) ou a instância DESTA conversa (contêiner, processo). `key`: ver `mcpServerKey`. */
  async clientFor(key: string, sessionId?: string): Promise<McpServerClient | undefined> {
    const config = this.servers.get(key)
    if (!config || !isLaunchedMcp(config)) return this.client(key)
    const project = this.projectOf(sessionId)
    // ⚖️ O `shared` que pede valor ao projeto vira UM POR PROJETO: o processo de um projeto nunca roda com a chave de outro.
    const instance = config.kind === 'process' && config.process?.scope === 'shared' ? (mcpAsksProject(config) ? `${SHARED}@${project ?? ''}` : SHARED) : sessionId
    if (!config.enabled || !instance) return undefined
    return (await this.instance(config, instance, project))?.client
  }

  private async instance(config: IMcpServerConfig, sessionId: string, project?: string): Promise<IInstance | undefined> {
    const key = `${mcpServerKey(config)}\u0000${sessionId}`
    const current = this.instances.get(key)
    if (current) {
      current.lastUsed = Date.now()
      return current
    }
    const pending = this.starting.get(key)
    if (pending) return pending

    const start = this.startInstance(config, sessionId, key, project).finally(() => this.starting.delete(key))
    this.starting.set(key, start)
    return start
  }

  private async startInstance(config: IMcpServerConfig, sessionId: string, key: string, project?: string): Promise<IInstance | undefined> {
    if (this.instances.size + this.starting.size > maxInstances()) throw new Error(`too many MCP instances running (MCP_CONTAINER_MAX=${maxInstances()}); try again later`)
    // As fixas por baixo, as do projeto por cima. A conversa (não a instância compartilhada nem o teste) aprende os secretos.
    const conversation = sessionId.startsWith(SHARED) || sessionId.startsWith('probe:') ? undefined : sessionId
    const vars = { ...mcpFixedVars(config), ...this.projectEnv(config, project, conversation) }
    const { client, cleanup } = config.kind === 'process' ? this.launchProcess(config, sessionId, vars, project) : await this.launchContainer(config, sessionId, vars)
    if (!(await client.connect())) {
      await client.close()
      await cleanup()
      throw new Error(client.lastError ?? `could not start the ${mcpServerKey(config)} MCP`)
    }

    const entry: IInstance = {
      client,
      sessionId,
      lastUsed: Date.now(),
      close: async () => {
        this.instances.delete(key)
        await client.close()
        await cleanup()
      },
    }
    this.instances.set(key, entry)
    this.startReaper()
    return entry
  }

  private async launchContainer(config: IMcpServerConfig, sessionId: string, vars: Record<string, string>): Promise<{ client: McpServerClient; cleanup: () => Promise<void> }> {
    const container = config.container!
    const serverKey = mcpServerKey(config)
    const instance = instanceName()
    const egress =
      container.network === 'allowlist' ? await openEgress(serverKey, instance, resolveAllowedHosts(container.allowedHosts, this.sessionLookup(sessionId)?.metadata)) : undefined

    const env = dockerEnv()
    const names = mcpVarNames(config).filter((name) => vars[name] !== undefined)
    for (const name of names) env[name] = vars[name]
    const args = containerArgs({
      image: container.image,
      args: container.args,
      writable: container.writable,
      memoryMb: container.memoryMb,
      cpus: container.cpus,
      envNames: names,
      network: egress ? { mode: 'allowlist', name: egress.name, proxyUrl: egress.proxyUrl } : { mode: 'none' },
      serverId: serverKey,
      instance,
    })
    const client = new McpServerClient(`container://${serverKey}`, {}, { auth: 'none', label: serverKey, stdio: { command: 'docker', args, env } })
    return { client, cleanup: async () => void (await egress?.close()) }
  }

  /**
   * ⚖️ PROCESSO DO GATEWAY, SEM TRAVA: quem cadastrou escolheu o alcance. ⛔ Só o ambiente: o básico
   * (`PATH`, `HOME`…) e as variáveis declaradas — o `.env` do gateway (chaves de API, segredo do JWT) não vai.
   * Por conversa, uma pasta de trabalho vazia, apagada junto com a instância; em `shared`, a do servidor.
   */
  private launchProcess(config: IMcpServerConfig, sessionId: string, vars: Record<string, string>, project?: string): { client: McpServerClient; cleanup: () => Promise<void> } {
    const proc = config.process!
    const serverKey = mcpServerKey(config)
    const command = resolveCommand(serverKey, proc)
    const env: Record<string, string> = { ...getDefaultEnvironment() }
    // Onde os gerenciadores instalam (o PVC): um `npx` dentro do MCP acha o que o `npm i -g` deixou.
    for (const name of INSTALL_PASSTHROUGH) if (process.env[name]) env[name] = process.env[name] as string
    for (const name of mcpVarNames(config)) if (vars[name] !== undefined) env[name] = vars[name]
    const shared = sessionId.startsWith(SHARED)
    // O compartilhado por projeto trabalha na pasta do projeto: os arquivos de um não aparecem para o outro.
    const cwd = shared ? join(installDir(serverKey), 'work', ...(sessionId === SHARED ? [] : [project || '_'])) : mkdtempSync(join(tmpdir(), `gw-mcp-${serverKey}-`))
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    // ⚠️ No pod o HOME é só leitura (`readOnlyRootFilesystem`), e MCP grava nele (o Playwright, em `~/.cache`).
    // Sem HOME gravável, o processo ganha um próprio: a pasta de trabalho dele.
    if (!isWritable(env.HOME)) env.HOME = cwd
    const client = new McpServerClient(`process://${serverKey}`, {}, { auth: 'none', label: serverKey, stdio: { command, args: proc.args, env, cwd } })
    return { client, cleanup: async () => (shared ? undefined : rmSync(cwd, { recursive: true, force: true })) }
  }

  /** Encerra as instâncias ociosas (ou todas, de um servidor — `serverId` é a chave). */
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

  /** Pela chave (`mcpServerKey`): um id solto só acha o global. */
  get(key: string): IMcpServerConfig | undefined {
    return this.servers.get(key)
  }

  /** O cliente de um servidor LIGADO; `undefined` se não existe ou está desligado. */
  client(key: string): McpServerClient | undefined {
    const config = this.servers.get(key)
    // Contêiner e processo não têm cliente compartilhado: sobem instâncias (`clientFor`).
    if (!config?.enabled || isLaunchedMcp(config)) {
      this.forget(key)
      return undefined
    }

    // ⛔ OAUTH: UM CLIENTE POR PESSOA. A sessão MCP aberta com o token de uma pessoa nunca atende outra; quem chama é
    // a pessoa do escopo da credencial (a da tela, ou a dona do turno). Sem pessoa, não há cliente.
    const person = config.auth === 'oauth' ? caller()?.id : undefined
    if (config.auth === 'oauth' && (!person || !this.oauth)) return undefined
    const slot = person ? `${key}\u0000${person}` : key
    const fingerprint = [
      config.url,
      config.transport,
      config.auth,
      config.headerName ?? '',
      config.identity ? 'identity' : '',
      config.oauth?.clientId ?? '',
      config.oauth?.scopes ?? '',
    ].join('\u0000')
    const current = this.clients.get(slot)
    if (current?.fingerprint === fingerprint) return current.client

    if (current) void current.client.close()
    const oauth = this.oauth
    const client = this.make(config, {
      auth: config.auth,
      transport: config.transport,
      label: key,
      callerHeader: config.auth === 'caller' ? config.headerName : undefined,
      ...(config.identity ? { identity: true } : {}),
      header: () => this.header(key),
      ...(person && oauth ? { bearer: () => oauth.accessToken(key, person) } : {}),
      fixedHeaders: () => this.fixedHeaders(this.servers.get(key) ?? config),
    })
    this.clients.set(slot, { fingerprint, client })
    return client
  }

  /** O header de `auth: header` agora, ou nada sem segredo salvo. */
  header(key: string): { name: string; value: string } | undefined {
    const config = this.servers.get(key)
    const value = this.secrets.get(mcpSecretKey(key))
    if (config?.auth !== 'header' || !value) return undefined
    return { name: config.headerName || 'Authorization', value }
  }

  /** O cliente, conectado agora (respeitando o backoff), ou `undefined`. Com `token`, conecta como quem chama (ver `ensureConnectedAs`). */
  async connected(key: string, sessionId?: string, token?: string): Promise<McpServerClient | undefined> {
    const client = await this.clientFor(key, sessionId).catch(() => undefined)
    const auth = this.servers.get(key)?.auth
    return client && (await client.ensureConnectedAs(auth === 'caller' ? token : undefined)) ? client : undefined
  }

  /** As ferramentas do servidor. `token`: a credencial de quem pede, que um servidor `caller` exige até para listar. */
  async tools(key: string, sessionId?: string, token?: string): Promise<IToolDefinition[]> {
    const caller = this.servers.get(key)?.auth === 'caller' ? token : undefined
    return (await this.connected(key, sessionId, caller))?.listToolsAs(caller) ?? []
  }

  /**
   * Para a tela: as ferramentas de um contêiner ou processo numa instância DESCARTÁVEL (aberta e fechada aqui). `project`:
   * de onde vêm os valores que o servidor pede ao projeto (o seletor da tela).
   */
  async probeTools(key: string, token?: string, project?: string): Promise<IToolDefinition[]> {
    const config = this.servers.get(key)
    if (!isLaunchedMcp(config)) return this.tools(key, undefined, token)
    const result = await this.test(key, token, project)
    return result.tools
  }

  /**
   * "Testar conexão": tenta AGORA, ignorando o backoff, e lista as ferramentas.
   * ⚖️ `token`: a credencial de quem está na tela. Um servidor `caller` (o MCP do próprio gateway) recusa a conexão
   * anônima — sem ela, o teste dava sempre "Error POSTing to endpoint", embora nas conversas funcionasse.
   */
  async test(key: string, token?: string, project?: string): Promise<{ ok: boolean; tools: IToolDefinition[]; message?: string }> {
    const config = this.servers.get(key)
    if (config && isLaunchedMcp(config)) {
      if (!config.enabled) return { ok: false, tools: [], message: 'server is disabled' }
      const probe = `probe:${instanceName()}`
      try {
        const entry = await this.instance(config, probe, project)
        const tools = (await entry?.client.listTools()) ?? []
        await entry?.close()
        return { ok: true, tools }
      } catch (error: unknown) {
        return { ok: false, tools: [], message: error instanceof Error ? error.message : String(error) }
      }
    }
    const client = this.client(key)
    if (!client && config?.auth === 'oauth' && config.enabled) return { ok: false, tools: [], message: 'connect your account first (Connect, on this server)' }
    if (!client) return { ok: false, tools: [], message: 'server is disabled or does not exist' }
    const caller = config?.auth === 'caller' ? token : undefined
    await client.close()
    // Sem credencial, `connect` (ignora o backoff, como o botão promete); com ela, a conexão como quem chama.
    if (!(caller ? await client.ensureConnectedAs(caller) : await client.connect())) return { ok: false, tools: [], message: client.lastError ?? 'could not connect' }
    return { ok: true, tools: await client.listToolsAs(caller) }
  }

  /** Conecta os ligados, sem bloquear quem chamou por um servidor fora do ar. */
  async connectAll(): Promise<void> {
    // Contêiner e processo não conectam no boot: a instância nasce na primeira ferramenta de cada conversa.
    await Promise.all(
      this.servers
        .list()
        .filter((config) => !isLaunchedMcp(config))
        .map((config) => this.client(mcpServerKey(config))?.connect()),
    )
  }

  status(): IMcpServerStatus[] {
    return this.servers.list().map((config) => {
      const key = mcpServerKey(config)
      const scope = { key, id: config.id, ...(config.projectId ? { projectId: config.projectId } : {}) }
      if (isLaunchedMcp(config)) {
        const instances = [...this.instances.keys()].filter((entry) => entry.startsWith(`${key}\u0000`)).length
        return { ...scope, name: config.name, enabled: config.enabled, connected: config.enabled, instances }
      }
      const client = config.enabled ? this.client(key) : undefined
      return { ...scope, name: config.name, enabled: config.enabled, connected: client?.isConnected() ?? false, ...(client?.lastError ? { lastError: client.lastError } : {}) }
    })
  }

  /** Fecha o cliente do servidor — e, no `oauth`, o de cada pessoa. `person`: só o dessa pessoa (desconectou). */
  forget(key: string, person?: string): void {
    for (const [slot, current] of this.clients) {
      const mine = person ? slot === `${key}\u0000${person}` : slot === key || slot.startsWith(`${key}\u0000`)
      if (!mine) continue
      this.clients.delete(slot)
      void current.client.close()
    }
  }
}
