import { InvalidMcpServerError, McpServerInUseError, McpServerNotFoundError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import {
  IMcpContainer,
  IMcpProcess,
  IMcpServerConfig,
  MCP_CONTAINER_DEFAULTS,
  MCP_PROCESS_DEFAULTS,
  MCP_SERVER_ID_PATTERN,
  mcpEnvNames,
  mcpEnvSecretKey,
  mcpSecretKey,
  mcpSelection,
  mcpServerKey,
  mcpServesProject,
  mcpUrlIssue,
  TMcpAuth,
  TMcpKind,
  TMcpTransport,
} from '@domain/models/McpServer.Model'
import { ICredentialStatus, ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { CatalogHistoryHook } from './CatalogHistory.Service'

export interface IMcpServerInput {
  id: string
  /** O projeto dono. Ausente = global. */
  projectId?: string
  name: string
  kind?: TMcpKind
  container?: Partial<IMcpContainer>
  process?: Partial<IMcpProcess>
  url?: string
  transport?: TMcpTransport
  auth?: TMcpAuth
  headerName?: string
  /** Envia a identidade do agente em cabeçalhos (ver `Agent.Identity`). */
  identity?: boolean
  /** O segredo de `auth: header`, na criação. Depois, por `saveSecret`. */
  secret?: string
}

export type TMcpServerChange = Partial<Pick<IMcpServerConfig, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'identity' | 'enabled'>> & {
  container?: Partial<IMcpContainer>
  process?: Partial<IMcpProcess>
  /** Troca o escopo: um projeto, ou `null` para global. Ausente = fica onde está. */
  projectId?: string | null
}

const NAME_MAX = 80
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const TRANSPORTS: TMcpTransport[] = ['auto', 'http', 'sse']
const AUTHS: TMcpAuth[] = ['caller', 'header', 'none']

/**
 * O cadastro de servidores MCP: quem existe, como se autentica e quem o usa.
 *
 * ⛔ O SEGREDO SÓ ENTRA: fica cifrado no mesmo cofre das chaves dos providers (`mcp:<id>`), e para fora
 * sai só "configurado" e os quatro últimos caracteres.
 */
/** O id do servidor MCP do próprio gateway (ver `Tools.Factory`). */
export const SELF_MCP_SERVER_ID = 'gateway'
/** Os ids das sementes globais (o MCP do gateway e o do `.env`): projeto não os toma, ou a semente colidiria. */
const RESERVED_GLOBAL_IDS = [SELF_MCP_SERVER_ID, 'default']

export class McpServersService {
  /**
   * O histórico do catálogo: toda escrita grava a revisão do servidor, pela CHAVE (`mcpServerKey`) — o escopo do
   * projeto faz parte dela. ⛔ O documento não leva segredo (ver `MCP_SHAPE`).
   */
  readonly history = new CatalogHistoryHook()

  constructor(
    private readonly servers: IMcpServerRepository,
    private readonly secrets: ICredentialStore,
    /** Os agentes como gravados (todas as escolhas, inclusive de servidor desligado). */
    private readonly agents: () => readonly IAgent[],
    /** O projeto existe? Sem projetos ligados, nenhum: só há servidor global. */
    private readonly projectExists: (projectId: string) => boolean = () => false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): IMcpServerConfig[] {
    return this.servers.list()
  }

  /** Por CHAVE (`mcpServerKey`): global é o id; de projeto, `<projeto>.<id>`. */
  get(key: string): IMcpServerConfig {
    const server = this.servers.get(key)
    if (!server) throw new McpServerNotFoundError(key)
    return server
  }

  secretStatus(key: string): ICredentialStatus {
    return this.secrets.status([mcpSecretKey(key)])[0]
  }

  /**
   * Os agentes que escolheram alguma ferramenta deste servidor — ⛔ só os que o ENXERGAM: `mcp:n8n/…` num agente do
   * projeto B não é uso do `n8n` do projeto A.
   */
  usedBy(key: string): IAgent[] {
    const server = this.servers.get(key)
    if (!server) return []
    return this.agents().filter((agent) => mcpServesProject(server, agent.projectId) && mcpSelection(agent.allowedTools).has(server.id))
  }

  /**
   * ⛔ O ID NUNCA FICA AMBÍGUO PARA UM AGENTE: dois projetos podem ter o mesmo id (cada um vê só o seu), mas global e de
   * projeto com o mesmo id, não — nos dois sentidos. `except`: a chave do próprio servidor (numa troca de escopo).
   */
  private scopeIssue(id: string, projectId: string | undefined, except?: string): string | undefined {
    return mcpScopeIssue(
      id,
      projectId,
      this.servers.list().filter((server) => mcpServerKey(server) !== except),
    )
  }

  private projectIssue(projectId: string | undefined): string | undefined {
    return projectId !== undefined && !this.projectExists(projectId) ? `no such project: ${projectId}` : undefined
  }

  create(input: IMcpServerInput, by: string): IMcpServerConfig {
    const kind = input.kind ?? 'remote'
    const projectId = input.projectId?.trim() || undefined
    const config: IMcpServerConfig = {
      id: input.id.trim(),
      ...(projectId ? { projectId } : {}),
      name: input.name.trim(),
      kind,
      ...(kind === 'container' ? { container: containerOf(input.container) } : {}),
      ...(kind === 'process' ? { process: processOf(input.process) } : {}),
      url: kind === 'remote' ? (input.url ?? '').trim() : '',
      transport: input.transport ?? 'auto',
      // ⛔ `none` por padrão: `caller` manda a sessão de quem conversa (o JWT do gateway) para o servidor,
      // e isso é escolha consciente de quem o cadastra, nunca o default.
      auth: input.auth ?? 'none',
      headerName: (input.auth ?? 'none') === 'none' ? undefined : input.headerName?.trim() || undefined,
      ...(input.identity ? { identity: true } : {}),
      enabled: true,
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = issuesOf(config)
    const projectIssue = this.projectIssue(projectId)
    if (projectIssue) issues.unshift({ field: 'projectId', message: projectIssue })
    const scopeIssue = MCP_SERVER_ID_PATTERN.test(config.id) ? this.scopeIssue(config.id, projectId) : undefined
    if (!MCP_SERVER_ID_PATTERN.test(config.id)) issues.unshift({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
    else if (scopeIssue) issues.unshift({ field: 'id', message: scopeIssue })
    if (issues.length) throw new InvalidMcpServerError(issues)

    this.servers.insert(config)
    if (input.secret?.trim()) this.secrets.save(mcpSecretKey(mcpServerKey(config)), input.secret.trim(), by)
    this.history.record([{ kind: 'mcp', id: mcpServerKey(config) }], { by })
    return config
  }

  /**
   * Edita pela chave. Com `projectId` (ou `null`), troca o escopo — e a chave, o segredo e as variáveis vão junto.
   *
   * ⛔ TROCA QUE DEIXARIA REFERÊNCIA CRUZADA É RECUSADA (409, com quem usa): o agente de fora do escopo novo perderia o
   * servidor — ou pior, um agente global passaria a citar um servidor de projeto. Tira-se a ferramenta do agente antes.
   */
  update(key: string, change: TMcpServerChange, by: string): IMcpServerConfig {
    const current = this.get(key)
    const { container, process: proc, projectId: scope, ...rest } = change
    const id = current.id
    const target = scope === undefined ? current.projectId : scope?.trim() || undefined
    const moving = target !== current.projectId
    const next: IMcpServerConfig = {
      ...current,
      ...definedOnly(rest),
      ...(current.kind === 'container' ? { container: containerOf({ ...current.container, ...definedOnly(container ?? {}) }) } : {}),
      ...(current.kind === 'process' ? { process: processOf({ ...current.process, ...definedOnly(proc ?? {}) }) } : {}),
    }
    next.headerName = next.auth === 'none' ? undefined : next.headerName?.trim() || undefined
    const issues = issuesOf(next)
    // ⛔ O servidor do próprio gateway é este processo: a URL dele não se edita, e a credencial é sempre a de quem
    // conversa (com outra, o MCP do gateway recusa toda chamada e o Atlas fica sem ferramenta).
    if (id === SELF_MCP_SERVER_ID && next.url !== current.url) issues.push({ field: 'url', message: 'the gateway server URL is fixed' })
    if (id === SELF_MCP_SERVER_ID && (next.auth !== current.auth || next.headerName !== current.headerName))
      issues.push({ field: 'auth', message: "the gateway server always uses the caller's credential" })
    if (moving) {
      const projectIssue = this.projectIssue(target)
      const scopeIssue = this.scopeIssue(id, target, key)
      if (!current.projectId && RESERVED_GLOBAL_IDS.includes(id)) issues.push({ field: 'projectId', message: `the ${id} server is global` })
      else if (projectIssue) issues.push({ field: 'projectId', message: projectIssue })
      else if (scopeIssue) issues.push({ field: 'projectId', message: scopeIssue })
    }
    if (issues.length) throw new InvalidMcpServerError(issues)
    if (moving) {
      const stranded = this.usedBy(key).filter((agent) => !mcpServesProject({ projectId: target }, agent.projectId))
      if (stranded.length)
        throw new McpServerInUseError(
          id,
          stranded.map((agent) => `${agent.name} (${agent.projectId ? `project ${agent.projectId}` : 'global'})`),
        )
    }

    const saved = this.servers.update(key, {
      name: next.name,
      url: next.url,
      transport: next.transport,
      auth: next.auth,
      headerName: next.headerName,
      identity: next.identity === true,
      enabled: next.enabled,
      ...(next.container ? { container: next.container } : {}),
      ...(next.process ? { process: next.process } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
    if (!moving) {
      this.history.record([{ kind: 'mcp', id: key }], { by })
      return saved
    }

    const moved = this.servers.move(key, target, this.now(), by)!
    const nextKey = mcpServerKey(moved)
    // O segredo é do servidor: muda de chave com ele (e a chave velha não fica valendo para ninguém).
    for (const [from, to] of [[mcpSecretKey(key), mcpSecretKey(nextKey)], ...mcpEnvNames(moved).map((name) => [mcpEnvSecretKey(key, name), mcpEnvSecretKey(nextKey, name)])]) {
      const value = this.secrets.get(from)
      if (value) this.secrets.save(to, value, by)
      this.secrets.clear(from)
    }
    // Trocar de escopo troca a chave: a antiga sai (delete), a nova entra (create).
    this.history.record(
      [
        { kind: 'mcp', id: key, ...(current.projectId ? { projectId: current.projectId } : {}) },
        { kind: 'mcp', id: nextKey },
      ],
      { by },
    )
    return moved
  }

  saveSecret(key: string, secret: string, by: string): void {
    this.get(key)
    if (!secret.trim()) throw new InvalidMcpServerError([{ field: 'secret', message: 'required' }])
    this.secrets.save(mcpSecretKey(key), secret.trim(), by)
  }

  clearSecret(key: string): void {
    this.get(key)
    this.secrets.clear(mcpSecretKey(key))
  }

  /** As variáveis secretas do contêiner ou do processo: o NOME e se há valor — ⛔ nunca o valor. */
  envStatus(key: string): Array<{ name: string; configured: boolean }> {
    const server = this.get(key)
    return mcpEnvNames(server).map((name) => ({ name, configured: this.secrets.status([mcpEnvSecretKey(key, name)])[0].configured }))
  }

  saveEnv(key: string, name: string, value: string, by: string): void {
    const server = this.get(key)
    if (!mcpEnvNames(server).includes(name)) throw new InvalidMcpServerError([{ field: 'env', message: `not a declared variable: ${name}` }])
    if (!value) throw new InvalidMcpServerError([{ field: 'env', message: 'required' }])
    this.secrets.save(mcpEnvSecretKey(key, name), value, by)
  }

  /** ⛔ Com agente usando, recusa e diz quais (409) — apagar deixaria ferramentas apontando para o nada. */
  remove(key: string, by: string): void {
    const server = this.get(key)
    const using = this.usedBy(key)
    if (using.length)
      throw new McpServerInUseError(
        server.id,
        using.map((agent) => agent.name),
      )
    this.forget(server)
    this.history.record([{ kind: 'mcp', id: key, ...(server.projectId ? { projectId: server.projectId } : {}) }], { by })
  }

  /**
   * O projeto foi apagado: os servidores dele (e as credenciais) vão junto. ⛔ Ficarem órfãos daria a um projeto novo
   * com o mesmo id as chaves do antigo. Devolve os que saíram (para fechar cliente, instâncias e pacote).
   */
  removeProject(projectId: string): IMcpServerConfig[] {
    const gone = this.servers.list().filter((server) => server.projectId === projectId)
    for (const server of gone) this.forget(server)
    return gone
  }

  private forget(server: IMcpServerConfig): void {
    const key = mcpServerKey(server)
    this.servers.delete(key)
    this.secrets.clear(mcpSecretKey(key))
    for (const name of mcpEnvNames(server)) this.secrets.clear(mcpEnvSecretKey(key, name))
  }
}

const IMAGE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
/**
 * ⛔ Nomes que não viram variável do contêiner: o valor passa pelo ambiente do processo `docker` DO HOST,
 * e com eles o admin redirecionaria o cliente do Docker (`DOCKER_HOST`), injetaria código (`LD_PRELOAD`,
 * `NODE_OPTIONS`) ou trocaria o proxy de egresso.
 */
const RESERVED_ENV = /^(DOCKER_.*|PATH|HOME|USER|SHELL|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|.*_PROXY|.*_proxy)$/i
const HOST_PATTERN = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$|^\{meta:[A-Za-z0-9_]+\}$/
/** Caminhos que nunca viram graváveis: são do kernel e do sistema. */
const FORBIDDEN_PATHS = /^\/(proc|sys|dev|etc|bin|sbin|usr|lib|var\/run|run)(\/|$)/

function containerOf(input: Partial<IMcpContainer> = {}): IMcpContainer {
  const clean = (list: unknown) => (Array.isArray(list) ? list.map((entry) => String(entry).trim()).filter(Boolean) : [])
  return {
    image: String(input.image ?? '').trim(),
    args: Array.isArray(input.args) ? input.args.map(String) : MCP_CONTAINER_DEFAULTS.args,
    writable: clean(input.writable),
    memoryMb: Number(input.memoryMb ?? MCP_CONTAINER_DEFAULTS.memoryMb),
    cpus: Number(input.cpus ?? MCP_CONTAINER_DEFAULTS.cpus),
    network: input.network === 'allowlist' ? 'allowlist' : 'none',
    allowedHosts: clean(input.allowedHosts),
    env: clean(input.env),
  }
}

/** ⛔ O que o cadastro pode pedir — e só isso: as travas do contêiner não passam por aqui. */
function containerIssues(container: IMcpContainer): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!IMAGE.test(container.image)) issues.push({ field: 'image', message: 'a Docker image like registry/name:tag' })
  if (container.args.length > 32 || container.args.some((arg) => arg.length > 300 || /[\n\r\0]/.test(arg)))
    issues.push({ field: 'args', message: 'up to 32 arguments, one line each' })
  for (const path of container.writable)
    if (!path.startsWith('/') || path === '/' || FORBIDDEN_PATHS.test(path) || path.includes('..')) issues.push({ field: 'writable', message: `not allowed: ${path}` })
  if (!(container.memoryMb >= 128 && container.memoryMb <= 4096)) issues.push({ field: 'memoryMb', message: '128 to 4096' })
  if (!(container.cpus >= 0.25 && container.cpus <= 4)) issues.push({ field: 'cpus', message: '0.25 to 4' })
  if (container.network === 'allowlist' && !container.allowedHosts.length) issues.push({ field: 'allowedHosts', message: 'list at least one domain (or {meta:key})' })
  for (const host of container.allowedHosts) if (!HOST_PATTERN.test(host)) issues.push({ field: 'allowedHosts', message: `not a domain: ${host}` })
  for (const name of container.env) {
    if (!ENV_NAME.test(name)) issues.push({ field: 'env', message: `use UPPER_CASE names: ${name}` })
    else if (RESERVED_ENV.test(name)) issues.push({ field: 'env', message: `reserved name, it would change the host docker process: ${name}` })
  }
  return issues
}

/** Spec npm: `nome`, `@escopo/nome`, com versão/tag opcional; ou `file:`/caminho absoluto de um pacote local. */
const NPM_SPEC = /^(?:(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~<>=*|+-]+)?|file:\S+|\/\S+)$/

function processOf(input: Partial<IMcpProcess> = {}): IMcpProcess {
  const clean = (list: unknown) => (Array.isArray(list) ? list.map((entry) => String(entry).trim()).filter(Boolean) : [])
  const pkg = String(input.package ?? '').trim()
  const command = String(input.command ?? '').trim()
  return {
    ...(pkg ? { package: pkg } : {}),
    ...(command ? { command } : {}),
    args: Array.isArray(input.args) ? input.args.map(String) : MCP_PROCESS_DEFAULTS.args,
    env: clean(input.env),
    scope: input.scope === 'shared' ? 'shared' : MCP_PROCESS_DEFAULTS.scope,
  }
}

/**
 * ⚖️ SÓ O FORMATO: o processo roda com o alcance do gateway por escolha de quem administra, então não há
 * lista de comandos nem de variáveis proibidas — o `RESERVED_ENV` é do contêiner (protege o `docker` do host).
 */
function processIssues(proc: IMcpProcess): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!proc.package && !proc.command) issues.push({ field: 'package', message: 'set an npm package or a command' })
  if (proc.package && (proc.package.length > 300 || !NPM_SPEC.test(proc.package))) issues.push({ field: 'package', message: 'an npm package like @scope/name@version' })
  if (proc.command && (proc.command.length > 300 || /[\n\r\0]/.test(proc.command))) issues.push({ field: 'command', message: 'one line, up to 300 characters' })
  if (proc.args.length > 32 || proc.args.some((arg) => arg.length > 300 || /[\n\r\0]/.test(arg))) issues.push({ field: 'args', message: 'up to 32 arguments, one line each' })
  for (const name of proc.env) if (!ENV_NAME.test(name)) issues.push({ field: 'env', message: `use UPPER_CASE names: ${name}` })
  if (proc.env.length > 20) issues.push({ field: 'env', message: 'up to 20 variables' })
  return issues
}

/**
 * ⛔ O ID NUNCA FICA AMBÍGUO PARA UM AGENTE: dois projetos podem ter o mesmo id (cada um vê só o seu), mas global e de
 * projeto com o mesmo id, não — nos dois sentidos. `others`: os outros servidores (sem o próprio, numa troca de escopo).
 */
export function mcpScopeIssue(id: string, projectId: string | undefined, servers: ReadonlyArray<Pick<IMcpServerConfig, 'id' | 'projectId'>>): string | undefined {
  const others = servers.filter((server) => server.id === id)
  if (projectId) {
    if (others.some((server) => !server.projectId)) return `already exists as a global server: ${id}`
    if (others.some((server) => server.projectId === projectId)) return `already exists in this project: ${id}`
    if (RESERVED_GLOBAL_IDS.includes(id)) return `reserved for the global server: ${id}`
    return undefined
  }
  if (others.some((server) => !server.projectId)) return `already exists: ${id}`
  const projects = [...new Set(others.flatMap((server) => (server.projectId ? [server.projectId] : [])))]
  return projects.length ? `already exists in project ${projects.join(', ')}: a global server with this id would be ambiguous` : undefined
}

/**
 * Os problemas do cadastro de um servidor, SEM gravar (as regras de `create`/`update`, sem o id e o escopo): o contêiner
 * e o processo passam pela mesma normalização da gravação antes de conferir.
 */
export function mcpServerIssues(config: IMcpServerConfig): Array<{ field: string; message: string }> {
  return issuesOf({
    ...config,
    ...(config.kind === 'container' ? { container: containerOf(config.container) } : {}),
    ...(config.kind === 'process' ? { process: processOf(config.process) } : {}),
  })
}

function issuesOf(config: IMcpServerConfig): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!config.name) issues.push({ field: 'name', message: 'required' })
  else if (config.name.length > NAME_MAX) issues.push({ field: 'name', message: `at most ${NAME_MAX} characters` })
  if (config.kind === 'container') return [...issues, ...containerIssues(config.container ?? containerOf())]
  if (config.kind === 'process') return [...issues, ...processIssues(config.process ?? processOf())]
  const urlIssue = mcpUrlIssue(config.url)
  if (urlIssue) issues.push({ field: 'url', message: urlIssue })
  if (!TRANSPORTS.includes(config.transport)) issues.push({ field: 'transport', message: `one of ${TRANSPORTS.join(', ')}` })
  if (!AUTHS.includes(config.auth)) issues.push({ field: 'auth', message: `one of ${AUTHS.join(', ')}` })
  if (config.headerName && !HEADER_NAME.test(config.headerName)) issues.push({ field: 'headerName', message: 'letters, digits and hyphens' })
  return issues
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
