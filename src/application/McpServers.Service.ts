import { InvalidMcpServerError, McpServerInUseError, McpServerNotFoundError } from '@domain/errors/Domain.Error'
import { IAgent } from '@domain/models/Agent.Model'
import { IMcpServerConfig, MCP_SERVER_ID_PATTERN, mcpSecretKey, mcpSelection, mcpUrlIssue, TMcpAuth, TMcpTransport } from '@domain/models/McpServer.Model'
import { ICredentialStatus, ICredentialStore } from '@domain/ports/CredentialStore.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'

export interface IMcpServerInput {
  id: string
  name: string
  url: string
  transport?: TMcpTransport
  auth?: TMcpAuth
  headerName?: string
  /** O segredo de `auth: header`, na criação. Depois, por `saveSecret`. */
  secret?: string
}

export type TMcpServerChange = Partial<Pick<IMcpServerConfig, 'name' | 'url' | 'transport' | 'auth' | 'headerName' | 'enabled'>>

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
    const config: IMcpServerConfig = {
      id: input.id.trim(),
      name: input.name.trim(),
      url: input.url.trim(),
      transport: input.transport ?? 'auto',
      auth: input.auth ?? 'caller',
      headerName: input.auth === 'header' ? input.headerName?.trim() || 'Authorization' : undefined,
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
    const next: IMcpServerConfig = { ...current, ...definedOnly(change) }
    next.headerName = next.auth === 'header' ? next.headerName?.trim() || 'Authorization' : undefined
    const issues = issuesOf(next)
    if (issues.length) throw new InvalidMcpServerError(issues)

    return this.servers.update(id, {
      name: next.name,
      url: next.url,
      transport: next.transport,
      auth: next.auth,
      headerName: next.headerName,
      enabled: next.enabled,
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

  /** ⛔ Com agente usando, recusa e diz quais (409) — apagar deixaria ferramentas apontando para o nada. */
  remove(id: string): void {
    this.get(id)
    const using = this.usedBy(id)
    if (using.length)
      throw new McpServerInUseError(
        id,
        using.map((agent) => agent.name),
      )
    this.servers.delete(id)
    this.secrets.clear(mcpSecretKey(id))
  }
}

function issuesOf(config: IMcpServerConfig): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = []
  if (!config.name) issues.push({ field: 'name', message: 'required' })
  else if (config.name.length > NAME_MAX) issues.push({ field: 'name', message: `at most ${NAME_MAX} characters` })
  const urlIssue = mcpUrlIssue(config.url)
  if (urlIssue) issues.push({ field: 'url', message: urlIssue })
  if (!TRANSPORTS.includes(config.transport)) issues.push({ field: 'transport', message: `one of ${TRANSPORTS.join(', ')}` })
  if (!AUTHS.includes(config.auth)) issues.push({ field: 'auth', message: `one of ${AUTHS.join(', ')}` })
  if (config.auth === 'header' && config.headerName && !HEADER_NAME.test(config.headerName)) issues.push({ field: 'headerName', message: 'letters, digits and hyphens' })
  return issues
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}
