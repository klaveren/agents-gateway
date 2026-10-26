import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { DelegationSlot, makeDelegateTool } from '@infra/tools/Delegate.Tool'
import { makeLocalTools } from '@infra/tools/Local.Tools'
import { DEFAULT_MCP_SERVER, ToolCatalog } from '@infra/tools/Tool.Catalog'
import { makeAgents } from './Agents.Factory'
import { makeCredentials } from './Credentials.Factory'

export interface ITools {
  /** Onde a ferramenta `delegate_to_agent` encontra o serviço (preenchido em `makeUsecases`). */
  delegation: DelegationSlot
  mcp: McpRegistry
  servers: IMcpServerRepository
  catalog: ToolCatalog
}

let instance: ITools | undefined

/**
 * Uma instância só, compartilhada: o catálogo, o cadastro de servidores MCP e os clientes deles.
 *
 * ⚖️ `MCP_SERVER_URL` VIRA O PRIMEIRO SERVIDOR (`default`, credencial de quem conversa), UMA VEZ por
 * banco: quem já usava o MCP do `.env` o encontra cadastrado. Depois disso, quem manda é a tela.
 */
export function makeTools(): ITools {
  if (!instance) {
    const configured = process.env.CONVERSATIONS_DB?.trim()
    const servers = new SqliteMcpServerRepository(configured === 'off' ? ':memory:' : configured || DEFAULT_DB_PATH)
    servers.seedOnce([...seedFromEnv(), selfServer()])
    keepSelfUrl(servers)

    const mcp = new McpRegistry(servers, makeCredentials())
    const delegation = new DelegationSlot()
    // Os SDKs agênticos chegam aos MCPs em contêiner pelo proxy do próprio gateway (`/v1/mcp-proxy/<id>`).
    const containerProxy = { base: selfUrl().replace(/\/v1\/mcp$/, '/v1/mcp-proxy') }
    instance = { delegation, mcp, servers, catalog: new ToolCatalog(mcp, makeLocalTools(), (allowed) => makeDelegateTool(runnableTargets(allowed), delegation), containerProxy) }
  }
  return instance
}

/** O MCP do PRÓPRIO gateway (`/v1/mcp`), cadastrado como servidor do sistema: é dele que o Atlas tira as ferramentas. */
export const SELF_MCP_SERVER = 'gateway'
const SYSTEM = 'system'

/**
 * Os alvos de delegação que PODEM abrir conversa agora — a ferramenta só anuncia esses ao modelo. Pedido
 * na hora (os agentes mudam), e sem nenhum ativo fica a lista original: a delegação explica o motivo.
 */
function runnableTargets(allowed: readonly string[]): string[] {
  const agents = makeAgents()
  const active = allowed.filter((id) => {
    const agent = agents.get(id)
    return !!agent && agents.isRunnable(agent)
  })
  return active.length ? active : [...allowed]
}

function selfUrl(env: NodeJS.ProcessEnv = process.env): string {
  const bound = env.HOST?.trim()
  const address = !bound || bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound
  return `http://${address.includes(':') ? `[${address}]` : address}:${Number.parseInt(env.PORT || '3000', 10)}/v1/mcp`
}

/**
 * ⚖️ CREDENCIAL DE QUEM CONVERSA, no header de conta da API (`X-Tool-Authorization`): quem fala com o Atlas
 * empresta a ELE as próprias permissões — admin escreve, membro só lê (as ferramentas de admin nem aparecem).
 */
function selfServer(): IMcpServerConfig {
  const now = new Date()
  return {
    id: SELF_MCP_SERVER,
    name: 'Gateway (este)',
    url: selfUrl(),
    transport: 'http',
    auth: 'caller',
    headerName: 'X-Tool-Authorization',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    updatedBy: SYSTEM,
  }
}

/** A porta pode mudar entre um boot e outro: o servidor do sistema acompanha (o editado pela tela, não). */
function keepSelfUrl(servers: IMcpServerRepository): void {
  const current = servers.get(SELF_MCP_SERVER)
  const url = selfUrl()
  // ⛔ Sempre a URL deste processo: o servidor `gateway` é este gateway, e não um endereço que se edita.
  if (current && current.url !== url) servers.update(SELF_MCP_SERVER, { url, updatedAt: new Date(), updatedBy: SYSTEM })
}

function seedFromEnv(env: NodeJS.ProcessEnv = process.env): IMcpServerConfig[] {
  const url = env.MCP_SERVER_URL?.trim()
  if (!url) return []
  const now = new Date()
  return [{ id: DEFAULT_MCP_SERVER, name: 'MCP do .env', url, transport: 'auto', auth: 'caller', enabled: true, createdAt: now, updatedAt: now, updatedBy: 'MCP_SERVER_URL' }]
}
