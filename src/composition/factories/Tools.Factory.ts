import type { IPermissionChecker } from '@application/Permissions.Service'
import { makePermissions } from './Permissions.Factory'
import { makeProjectAccounts } from './ProjectAccounts.Factory'
import { makeSecretMasker } from './SecretMask.Factory'
import { makeGuidance } from './Guidance.Factory'
import { makeConversationRepository } from './Conversations.Factory'
import { IMcpServerConfig } from '@domain/models/McpServer.Model'
import { IConversationRepository } from '@domain/ports/ConversationRepository.Port'
import { IMcpServerRepository } from '@domain/ports/McpServerRepository.Port'
import { McpRegistry } from '@infra/mcp/Mcp.Registry'
import { DEFAULT_DB_PATH } from '@infra/persistence/Sqlite.ConversationRepository'
import { SqliteMcpServerRepository } from '@infra/persistence/Sqlite.McpServerRepository'
import { DelegationSlot, makeDelegateTool } from '@infra/tools/Delegate.Tool'
import { ITodoStore, makeLocalTools } from '@infra/tools/Local.Tools'
import { LoopGuard } from '@infra/tools/Loop.Guard'
import { IEditDiagnostics, makeEditDiagnostics } from '@infra/tools/Edit.Diagnostics'
import { DEFAULT_MCP_SERVER, ToolCatalog } from '@infra/tools/Tool.Catalog'
import { makeAgents } from './Agents.Factory'
import { makeCredentials } from './Credentials.Factory'
import { makeImportBuild } from './ImportBuild.Factory'

export interface ITools {
  /** Onde a ferramenta `delegate_to_agent` encontra o serviço (preenchido em `makeUsecases`). */
  delegation: DelegationSlot
  mcp: McpRegistry
  servers: IMcpServerRepository
  catalog: ToolCatalog
}

let instance: ITools | undefined

let loops: LoopGuard | undefined
/** O detector de laço (ver `Loop.Guard`): um só, para as ferramentas locais, o Claude e o provider. */
export function loopGuard(): LoopGuard {
  loops ??= new LoopGuard()
  return loops
}

let diagnostics: IEditDiagnostics | undefined
/** O diagnóstico depois de editar (ver `Edit.Diagnostics`): um só, para as ferramentas locais e o Claude. */
export function editDiagnostics(): IEditDiagnostics {
  diagnostics ??= makeEditDiagnostics({ permissions: lazyPermissions })
  return diagnostics
}

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
    instance = {
      delegation,
      mcp,
      servers,
      catalog: new ToolCatalog(
        mcp,
        makeLocalTools({
          docs: makeGuidance(),
          resources: makeGuidance(),
          triggers: {
            // Só agente gravado: o de fábrica (Atlas, construtores) não se edita e responde como inexistente.
            triggersOf: (agentId) => {
              const entry = makeAgents()
                .rawEntries()
                .find((item) => item.agent.id === agentId)
              return entry ? (entry.agent.triggers ?? []) : undefined
            },
            saveTriggers: (agentId, triggers, by) => makeAgents().saveTriggers(agentId, triggers, by),
          },
          drafts: makeGuidance(),
          imports: {
            listText: (conversationId) => makeImportBuild().listText(conversationId),
            readSource: (conversationId, key, options) => makeImportBuild().readSource(conversationId, key, options),
            propose: (conversationId, key, meta, ops) => makeImportBuild().propose(conversationId, key, meta, ops),
          },
          todos: todoStore(),
          permissions: lazyPermissions,
          agentTerminal: (agentId) => makeAgents().get(agentId)?.terminal,
          agentEnv: (agentId) => makeAgents().get(agentId)?.env,
          mask: makeSecretMasker(),
          loops: loopGuard(),
          diagnostics: editDiagnostics(),
          agentDiagnostics: (agentId) => makeAgents().get(agentId)?.diagnostics,
          accounts: {
            commandEnv: (projectId, allowed) => makeProjectAccounts().commandEnv(projectId, allowed),
            sign: (projectId, id, namespace, data) => makeProjectAccounts().sign(projectId, id, namespace, data),
          },
        }),
        (allowed) => makeDelegateTool(runnableTargets(allowed), delegation, lazyPermissions),
        containerProxy,
        lazyPermissions,
      ),
    }
    const masker = makeSecretMasker()
    instance.catalog.useMask((text, sessionId) => masker.text(text, sessionId))
  }
  return instance
}

/** As permissões, pedidas na hora (a fábrica delas lê os agentes, que leem o catálogo de ferramentas ao nascer). */
const lazyPermissions: IPermissionChecker = {
  check: (asker, subject, options) => makePermissions().check(asker, subject, options),
  layers: (asker) => makePermissions().layers(asker),
}

/** Onde o `update_todos` grava: o banco das conversas, aberto na primeira tarefa (uma conexão a mais no mesmo arquivo). */
let todos: IConversationRepository | undefined
function todoStore(): ITodoStore {
  return {
    saveTodos: async (sessionId, items) => {
      todos ??= makeConversationRepository()
      if (!todos.saveTodos) throw new Error('Conversations are not being recorded on this gateway')
      await todos.saveTodos(sessionId, items)
    },
  }
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

/** O MCP do próprio gateway neste processo (`http://<host>:<porta>/v1/mcp`); sem o `/mcp`, a base da API. */
export function selfUrl(env: NodeJS.ProcessEnv = process.env): string {
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

/**
 * A porta pode mudar entre um boot e outro: o servidor do sistema acompanha. ⛔ E a credencial dele é sempre a de
 * quem conversa, no header que o gateway lê (`X-Tool-Authorization`): gravado com outra (pela tela, num banco
 * antigo), o MCP do gateway recusava toda chamada — "Missing caller credential" — e o Atlas ficava sem ferramenta.
 */
function keepSelfUrl(servers: IMcpServerRepository): void {
  const current = servers.get(SELF_MCP_SERVER)
  if (!current) return
  const expected = selfServer()
  const drift = current.url !== expected.url || current.auth !== expected.auth || current.headerName !== expected.headerName
  if (drift) servers.update(SELF_MCP_SERVER, { url: expected.url, auth: expected.auth, headerName: expected.headerName, updatedAt: new Date(), updatedBy: SYSTEM })
}

function seedFromEnv(env: NodeJS.ProcessEnv = process.env): IMcpServerConfig[] {
  const url = env.MCP_SERVER_URL?.trim()
  if (!url) return []
  const now = new Date()
  return [{ id: DEFAULT_MCP_SERVER, name: 'MCP do .env', url, transport: 'auto', auth: 'caller', enabled: true, createdAt: now, updatedAt: now, updatedBy: 'MCP_SERVER_URL' }]
}
