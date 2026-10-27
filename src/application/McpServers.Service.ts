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
  mcpUrlIssue,
  TMcpAuth,
  TMcpKind,
  TMcpTransport,
} from '@domain/models/McpServer.Model'
import { ICredentialStatus, ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'

export interface IMcpServerInput {
  id: string
  name: string
  kind?: TMcpKind
  container?: Partial<IMcpContainer>
  process?: Partial<IMcpProcess>
  url?: string
  transport?: TMcpTransport
  auth?: TMcpAuth
  headerName?: string
  /** O segredo de `auth: header`, na criação. Depois, por `saveSecret`. */
  secret?: string
}

export type TMcpServerChange = Partial<Pick<IMcpServerConfig, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'enabled'>> & {
  container?: Partial<IMcpContainer>
  process?: Partial<IMcpProcess>
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
const SELF_MCP_SERVER_ID = 'gateway'

export class McpServersService {
  constructor(
    private readonly servers: IMcpServerRepository,
    private readonly secrets: ICredentialStore,
    /** Os agentes como gravados (todas as escolhas, inclusive de servidor desligado). */
    private readonly agents: () => readonly IAgent[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): IMcpServerConfig[] {
    return this.servers.list()
  }

  get(id: string): IMcpServerConfig {
    const server = this.servers.get(id)
    if (!server) throw new McpServerNotFoundError(id)
    return server
  }

  secretStatus(id: string): ICredentialStatus {
    return this.secrets.status([mcpSecretKey(id)])[0]
  }

  /** Os agentes que escolheram alguma ferramenta deste servidor. */
  usedBy(id: string): IAgent[] {
    return this.agents().filter((agent) => mcpSelection(agent.allowedTools).has(id))
  }

  create(input: IMcpServerInput, by: string): IMcpServerConfig {
    const kind = input.kind ?? 'remote'
    const config: IMcpServerConfig = {
      id: input.id.trim(),
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
      enabled: true,
      createdAt: this.now(),
      updatedAt: this.now(),
      updatedBy: by,
    }
    const issues = issuesOf(config)
    if (!MCP_SERVER_ID_PATTERN.test(config.id)) issues.unshift({ field: 'id', message: 'use 2–32 lowercase letters, digits or hyphens' })
    else if (this.servers.get(config.id)) issues.unshift({ field: 'id', message: `already exists: ${config.id}` })
    if (issues.length) throw new InvalidMcpServerError(issues)

    this.servers.insert(config)
    if (input.secret?.trim()) this.secrets.save(mcpSecretKey(config.id), input.secret.trim(), by)
    return config
  }

  update(id: string, change: TMcpServerChange, by: string): IMcpServerConfig {
    const current = this.get(id)
    const { container, process: proc, ...rest } = change
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
    if (issues.length) throw new InvalidMcpServerError(issues)

    return this.servers.update(id, {
      name: next.name,
      url: next.url,
      transport: next.transport,
      auth: next.auth,
      headerName: next.headerName,
      enabled: next.enabled,
      ...(next.container ? { container: next.container } : {}),
      ...(next.process ? { process: next.process } : {}),
      updatedAt: this.now(),
      updatedBy: by,
    })!
  }

  saveSecret(id: string, secret: string, by: string): void {
    this.get(id)
    if (!secret.trim()) throw new InvalidMcpServerError([{ field: 'secret', message: 'required' }])
    this.secrets.save(mcpSecretKey(id), secret.trim(), by)
  }

  clearSecret(id: string): void {
    this.get(id)
    this.secrets.clear(mcpSecretKey(id))
  }

  /** As variáveis secretas do contêiner ou do processo: o NOME e se há valor — ⛔ nunca o valor. */
  envStatus(id: string): Array<{ name: string; configured: boolean }> {
    const server = this.get(id)
    return mcpEnvNames(server).map((name) => ({ name, configured: this.secrets.status([mcpEnvSecretKey(id, name)])[0].configured }))
  }

  saveEnv(id: string, name: string, value: string, by: string): void {
    const server = this.get(id)
    if (!mcpEnvNames(server).includes(name)) throw new InvalidMcpServerError([{ field: 'env', message: `not a declared variable: ${name}` }])
    if (!value) throw new InvalidMcpServerError([{ field: 'env', message: 'required' }])
    this.secrets.save(mcpEnvSecretKey(id, name), value, by)
  }

  /** ⛔ Com agente usando, recusa e diz quais (409) — apagar deixaria ferramentas apontando para o nada. */
  remove(id: string): void {
    this.get(id)
    const using = this.usedBy(id)
    if (using.length)
      throw new McpServerInUseError(
        id,
        using.map((agent) => agent.name),
      )
    const server = this.servers.get(id)
    this.servers.delete(id)
    this.secrets.clear(mcpSecretKey(id))
    for (const name of server ? mcpEnvNames(server) : []) this.secrets.clear(mcpEnvSecretKey(id, name))
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
